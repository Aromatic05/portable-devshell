import {
    type InstanceName,
    type JsonValue,
    type ToolCallContext,
    type ToolCallFailureStage,
    type ToolCallQuery,
    type ToolCallRecord,
} from "@portable-devshell/shared";

import type { AuditToolCalls, AuditToolCallFailureSummary } from "../../../audit/Public.js";

interface ActiveToolCall {
    callId: string;
    inputSummary: string;
    input?: JsonValue;
    requestId?: string;
    ctxId?: string;
    source: ToolCallContext["source"];
    startedAt: string;
    status: ToolCallRecord["status"];
    toolName: string;
    workspace?: string;
}

interface ToolCallCompletionResult {
    executionCompleted?: boolean;
    exitCode?: number | null;
    failureStage?: ToolCallFailureStage;
    output?: JsonValue;
    stderrBytes?: number;
    stdoutBytes?: number;
    termSignal?: number;
    termination?: "exited" | "signaled" | "timeout";
}

export class ToolCallHistory {
    readonly #instanceName: InstanceName;
    readonly #store: AuditToolCalls;
    readonly #activeCalls = new Map<string, ActiveToolCall>();

    constructor(instanceName: InstanceName, store: AuditToolCalls) {
        this.#instanceName = instanceName;
        this.#store = store;
    }

    async started(
        callId: string,
        toolName: string,
        inputSummary: string,
        context: ToolCallContext,
        startedAt: string,
        status: ToolCallRecord["status"] = "running",
        input?: JsonValue,
    ): Promise<void> {
        this.#activeCalls.set(callId, {
            callId,
            inputSummary,
            input,
            requestId: context.requestId,
            ctxId: context.ctxId,
            source: context.source,
            startedAt,
            status,
            toolName,
            workspace: context.workspace,
        });
    }

    async running(callId: string): Promise<void> {
        const activeCall = this.#readActiveCall(callId);
        activeCall.status = "running";
    }

    async completed(
        callId: string,
        completedAt: string,
        result?: ToolCallCompletionResult,
    ): Promise<ToolCallRecord> {
        return await this.#finishRunning(
            callId,
            completedAt,
            "completed",
            undefined,
            result,
        );
    }

    async failed(
        callId: string,
        error: string,
        completedAt: string,
        result?: ToolCallCompletionResult,
    ): Promise<ToolCallRecord> {
        return await this.#finishRunning(
            callId,
            completedAt,
            "failed",
            error,
            result,
        );
    }

    async denied(
        callId: string,
        error: string,
        completedAt: string,
    ): Promise<ToolCallRecord> {
        return await this.#finishNonRunning(
            callId,
            error,
            completedAt,
            "denied",
        );
    }

    async queueTimeout(
        callId: string,
        error: string,
        completedAt: string,
    ): Promise<ToolCallRecord> {
        return await this.#finishNonRunning(
            callId,
            error,
            completedAt,
            "queueTimeout",
        );
    }

    async cancelled(
        callId: string,
        error: string,
        completedAt: string,
    ): Promise<ToolCallRecord> {
        return await this.#finishNonRunning(
            callId,
            error,
            completedAt,
            "cancelled",
        );
    }

    hasActive(callId: string): boolean {
        return this.#activeCalls.has(callId);
    }

    hasActiveForContext(ctxId: string, excludeCallId?: string): boolean {
        for (const call of this.#activeCalls.values()) {
            if (call.ctxId === ctxId && call.callId !== excludeCallId)
                return true;
        }
        return false;
    }

    async read(query: ToolCallQuery = {}): Promise<ToolCallRecord[]> {
        if (hasCursor(query)) return await this.#readCursorQuery(query);
        const records = this.#store.readQuery(query);
        const activeRecords = this.#readActiveRecords();
        const filtered = sliceByFilters(
            sliceByCursor([...records, ...activeRecords], query),
            query,
        );
        return finalizeRecords(filtered, query);
    }

    async #readCursorQuery(query: ToolCallQuery): Promise<ToolCallRecord[]> {
        const activeRecords = this.#readActiveRecords();
        const afterActiveIndex =
            query.after === undefined
                ? -1
                : findCursorIndex(activeRecords, query.after);
        const beforeActiveIndex =
            query.before === undefined
                ? -1
                : findCursorIndex(activeRecords, query.before);
        const afterPersisted =
            query.after === undefined || afterActiveIndex >= 0
                ? false
                : await this.#store.hasCall(query.after);
        const beforePersisted =
            query.before === undefined || beforeActiveIndex >= 0
                ? false
                : await this.#store.hasCall(query.before);

        if (
            query.after !== undefined &&
            afterActiveIndex < 0 &&
            !afterPersisted
        )
            return [];
        if (
            query.before !== undefined &&
            beforeActiveIndex < 0 &&
            !beforePersisted
        )
            return [];

        let persistedRecords: ToolCallRecord[] = [];
        if (afterActiveIndex < 0) {
            const persistedQuery =
                beforeActiveIndex < 0 ? query : { ...query, before: undefined };
            persistedRecords = await this.#store.readQuery(persistedQuery);
        }

        let activeStart = 0;
        let activeEnd = activeRecords.length;
        if (afterActiveIndex >= 0) activeStart = afterActiveIndex + 1;
        if (beforeActiveIndex >= 0) activeEnd = beforeActiveIndex;
        else if (beforePersisted) activeEnd = 0;
        if (activeStart > activeEnd) return [];

        const activeSlice = sliceByFilters(
            activeRecords.slice(activeStart, activeEnd),
            query,
        );
        return finalizeRecords([...persistedRecords, ...activeSlice], query);
    }

    async readFailureSummary(
        sinceMs: number,
        untilMs: number,
    ): Promise<AuditToolCallFailureSummary> {
        return this.#store.readFailureSummary(sinceMs, untilMs);
    }

    #readActiveCall(callId: string): ActiveToolCall {
        const activeCall = this.#activeCalls.get(callId);

        if (activeCall === undefined) {
            throw new Error(`Active tool call ${callId} was not found.`);
        }

        return activeCall;
    }

    #readActiveRecords(): ToolCallRecord[] {
        return [...this.#activeCalls.values()].map((activeCall) => ({
            ...activeCall,
            instance: this.#instanceName,
        }));
    }

    async #finishRunning(
        callId: string,
        completedAt: string,
        status: Extract<ToolCallRecord["status"], "completed" | "failed">,
        error?: string,
        result?: ToolCallCompletionResult,
    ): Promise<ToolCallRecord> {
        const startedRecord = this.#readActiveCall(callId);
        const record: ToolCallRecord = {
            ...startedRecord,
            completedAt,
            ...(error === undefined ? {} : { error }),
            ...(result?.executionCompleted === undefined
                ? {}
                : { executionCompleted: result.executionCompleted }),
            ...(result?.exitCode === undefined
                ? {}
                : { exitCode: result.exitCode }),
            ...(result?.failureStage === undefined
                ? {}
                : { failureStage: result.failureStage }),
            instance: this.#instanceName,
            ...(result?.output === undefined ? {} : { output: result.output }),
            status,
            ...(result?.stderrBytes === undefined
                ? {}
                : { stderrBytes: result.stderrBytes }),
            ...(result?.stdoutBytes === undefined
                ? {}
                : { stdoutBytes: result.stdoutBytes }),
            ...(result?.termSignal === undefined
                ? {}
                : { termSignal: result.termSignal }),
            ...(result?.termination === undefined
                ? {}
                : { termination: result.termination }),
        };

        await this.#store.append(record);
        this.#activeCalls.delete(callId);
        return record;
    }

    async #finishNonRunning(
        callId: string,
        error: string,
        completedAt: string,
        status: Extract<
            ToolCallRecord["status"],
            "denied" | "queueTimeout" | "cancelled"
        >,
    ): Promise<ToolCallRecord> {
        const startedRecord = this.#readActiveCall(callId);
        const record: ToolCallRecord = {
            ...startedRecord,
            completedAt,
            error,
            instance: this.#instanceName,
            status,
        };

        await this.#store.append(record);
        this.#activeCalls.delete(callId);
        return record;
    }
}

function sliceByFilters(
    records: ToolCallRecord[],
    query: ToolCallQuery,
): ToolCallRecord[] {
    const callIds =
        query.callIds === undefined ? undefined : new Set(query.callIds);
    return records.filter((record) => {
        if (callIds !== undefined && !callIds.has(record.callId)) {
            return false;
        }

        if (query.ctxId !== undefined && record.ctxId !== query.ctxId) {
            return false;
        }

        if (
            query.workspace !== undefined &&
            record.workspace !== query.workspace
        ) {
            return false;
        }

        if (query.source !== undefined && record.source !== query.source) {
            return false;
        }

        if (query.status !== undefined && record.status !== query.status) {
            return false;
        }

        if (
            query.toolName !== undefined &&
            record.toolName !== query.toolName
        ) {
            return false;
        }

        return true;
    });
}

function sliceByCursor(
    records: ToolCallRecord[],
    query: ToolCallQuery,
): ToolCallRecord[] {
    const startIndex =
        query.after === undefined
            ? 0
            : findCursorIndex(records, query.after) + 1;
    const endIndex =
        query.before === undefined
            ? records.length
            : findCursorIndex(records, query.before);

    if (startIndex === 0 && query.after !== undefined) {
        return [];
    }

    if (endIndex === -1) {
        return [];
    }

    if (startIndex > endIndex) {
        return [];
    }

    return records.slice(startIndex, endIndex);
}

function applyLimit(
    records: ToolCallRecord[],
    query: ToolCallQuery,
): ToolCallRecord[] {
    if (query.limit === undefined) {
        return records;
    }

    if (query.after !== undefined) {
        return records.slice(0, query.limit);
    }

    return records.slice(-query.limit);
}

function finalizeRecords(
    records: ToolCallRecord[],
    query: ToolCallQuery,
): ToolCallRecord[] {
    const projected = records.map((record) => projectRecord(record, query));
    return applyByteLimit(applyLimit(projected, query), query);
}

function projectRecord(
    record: ToolCallRecord,
    query: ToolCallQuery,
): ToolCallRecord {
    if (query.includeInput !== false && query.includeOutput !== false)
        return record;
    const projected = { ...record };
    if (query.includeInput === false) delete projected.input;
    if (query.includeOutput === false) delete projected.output;
    return projected;
}

function applyByteLimit(
    records: ToolCallRecord[],
    query: ToolCallQuery,
): ToolCallRecord[] {
    if (query.maxBytes === undefined) return records;
    const newestFirst = query.after === undefined;
    const candidates = newestFirst ? [...records].reverse() : records;
    const accepted: ToolCallRecord[] = [];
    let bytes = 2;
    for (const record of candidates) {
        const recordBytes =
            Buffer.byteLength(JSON.stringify(record), "utf8") +
            (accepted.length === 0 ? 0 : 1);
        if (bytes + recordBytes > query.maxBytes) break;
        if (newestFirst) accepted.unshift(record);
        else accepted.push(record);
        bytes += recordBytes;
    }
    return accepted;
}

function hasCursor(query: ToolCallQuery): boolean {
    return query.after !== undefined || query.before !== undefined;
}

function findCursorIndex(records: ToolCallRecord[], callId: string): number {
    return records.findIndex((record) => record.callId === callId);
}
