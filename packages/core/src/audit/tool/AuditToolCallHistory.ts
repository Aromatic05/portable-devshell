import {
    type InstanceName,
    type JsonValue,
    type ToolCallContext,
    type ToolCallQuery,
    type ToolCallApprovalDecision,
    type ToolCallAssociation,
    type ToolCallRecord
} from "@portable-devshell/shared";

import type { AuditRecordStore } from "../AuditRecordStore.js";
import type {
    AuditToolCallFailureSummary,
    AuditToolCallRecordStore,
} from "../AuditDatabase.js";

type ToolCallHistoryStore = AuditRecordStore<ToolCallRecord> &
    Partial<Pick<AuditToolCallRecordStore, "hasCall" | "readFailureSummary" | "readQuery">>;

interface ActiveToolCall {
    approvalId?: string;
    callId: string;
    decision?: ToolCallApprovalDecision;
    inputSummary: string;
    input?: JsonValue;
    requestId?: string;
    ctxId?: string;
    source: ToolCallContext["source"];
    startedAt: string;
    status: ToolCallRecord["status"];
    taskId?: string;
    todoItemId?: string;
    toolName: string;
    workspace?: string;
}

interface ToolCallCompletionResult {
    exitCode?: number | null;
    output?: JsonValue;
    stderrBytes?: number;
    stdoutBytes?: number;
    termSignal?: number;
    termination?: "exited" | "signaled" | "timeout";
}

export class AuditToolCallHistory {
    readonly #instanceName: InstanceName;
    readonly #store: ToolCallHistoryStore;
    readonly #activeCalls = new Map<string, ActiveToolCall>();
    #initialized = false;

    constructor(instanceName: InstanceName, store: ToolCallHistoryStore) {
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
        association?: ToolCallAssociation,
        input?: JsonValue
    ): Promise<void> {
        await this.#initialize();
        this.#activeCalls.set(callId, {
            callId,
            inputSummary,
            input,
            requestId: context.requestId,
            ctxId: context.ctxId,
            source: context.source,
            startedAt,
            status,
            taskId: association?.taskId,
            todoItemId: association?.todoItemId,
            toolName,
            workspace: context.workspace,
        });
    }

    async pendingApproval(callId: string, approvalId: string): Promise<void> {
        await this.#initialize();
        const activeCall = this.#readActiveCall(callId);
        activeCall.approvalId = approvalId;
        activeCall.status = "pendingApproval";
    }

    async running(callId: string, decision?: ToolCallApprovalDecision): Promise<void> {
        await this.#initialize();
        const activeCall = this.#readActiveCall(callId);
        activeCall.status = "running";
        activeCall.decision = decision;
    }

    async completed(
        callId: string,
        completedAt: string,
        result?: ToolCallCompletionResult
    ): Promise<ToolCallRecord> {
        return await this.#finishRunning(callId, completedAt, "completed", undefined, result);
    }

    async failed(
        callId: string,
        error: string,
        completedAt: string,
        result?: ToolCallCompletionResult
    ): Promise<ToolCallRecord> {
        return await this.#finishRunning(callId, completedAt, "failed", error, result);
    }

    async denied(callId: string, error: string, completedAt: string): Promise<ToolCallRecord> {
        return await this.#finishNonRunning(callId, error, completedAt, "denied", "denied");
    }

    async expired(callId: string, error: string, completedAt: string): Promise<ToolCallRecord> {
        return await this.#finishNonRunning(callId, error, completedAt, "expired", "expired");
    }

    async queueTimeout(callId: string, error: string, completedAt: string): Promise<ToolCallRecord> {
        return await this.#finishNonRunning(callId, error, completedAt, "queueTimeout");
    }

    async cancelled(callId: string, error: string, completedAt: string): Promise<ToolCallRecord> {
        return await this.#finishNonRunning(callId, error, completedAt, "cancelled");
    }

    hasActive(callId: string): boolean {
        return this.#activeCalls.has(callId);
    }

    hasActiveForContext(ctxId: string, excludeCallId?: string): boolean {
        for (const call of this.#activeCalls.values()) {
            if (call.ctxId === ctxId && call.callId !== excludeCallId) return true;
        }
        return false;
    }

    async read(query: ToolCallQuery = {}): Promise<ToolCallRecord[]> {
        await this.#initialize();
        if (hasCursor(query) && this.#store.readQuery !== undefined && this.#store.hasCall !== undefined) {
            return await this.#readCursorQuery(query);
        }
        const records = canReadQuery(query) && this.#store.readQuery !== undefined
            ? await this.#store.readQuery(query)
            : canReadTail(query) && this.#store.readTail !== undefined
              ? await this.#store.readTail(query.limit!)
              : await this.#store.readAll();
        const activeRecords = this.#readActiveRecords();
        const filtered = sliceByFilters(sliceByCursor([...records, ...activeRecords], query), query);
        return applyLimit(filtered, query);
    }

    async #readCursorQuery(query: ToolCallQuery): Promise<ToolCallRecord[]> {
        const activeRecords = this.#readActiveRecords();
        const afterActiveIndex = query.after === undefined ? -1 : findCursorIndex(activeRecords, query.after);
        const beforeActiveIndex = query.before === undefined ? -1 : findCursorIndex(activeRecords, query.before);
        const afterPersisted = query.after === undefined || afterActiveIndex >= 0
            ? false
            : await this.#store.hasCall!(query.after);
        const beforePersisted = query.before === undefined || beforeActiveIndex >= 0
            ? false
            : await this.#store.hasCall!(query.before);

        if (query.after !== undefined && afterActiveIndex < 0 && !afterPersisted) return [];
        if (query.before !== undefined && beforeActiveIndex < 0 && !beforePersisted) return [];

        let persistedRecords: ToolCallRecord[] = [];
        if (afterActiveIndex < 0) {
            const persistedQuery = beforeActiveIndex < 0
                ? query
                : { ...query, before: undefined };
            persistedRecords = await this.#store.readQuery!(persistedQuery);
        }

        let activeStart = 0;
        let activeEnd = activeRecords.length;
        if (afterActiveIndex >= 0) activeStart = afterActiveIndex + 1;
        if (beforeActiveIndex >= 0) activeEnd = beforeActiveIndex;
        else if (beforePersisted) activeEnd = 0;
        if (activeStart > activeEnd) return [];

        const activeSlice = sliceByFilters(activeRecords.slice(activeStart, activeEnd), query);
        return applyLimit([...persistedRecords, ...activeSlice], query);
    }

    async readFailureSummary(sinceMs: number, untilMs: number): Promise<AuditToolCallFailureSummary> {
        await this.#initialize();
        if (this.#store.readFailureSummary !== undefined) {
            return await this.#store.readFailureSummary(sinceMs, untilMs);
        }
        const failures = (await this.#store.readAll())
            .filter((record) => isFailureInWindow(record, sinceMs, untilMs))
            .sort((left, right) => failureTimestamp(right) - failureTimestamp(left));
        return {
            count: failures.length,
            ...(failures[0] === undefined ? {} : { latest: failures[0] }),
        };
    }

    async #initialize(): Promise<void> {
        if (this.#initialized) {
            return;
        }
        this.#initialized = true;
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
            instance: this.#instanceName
        }));
    }

    async #finishRunning(
        callId: string,
        completedAt: string,
        status: Extract<ToolCallRecord["status"], "completed" | "failed">,
        error?: string,
        result?: ToolCallCompletionResult
    ): Promise<ToolCallRecord> {
        await this.#initialize();
        const startedRecord = this.#readActiveCall(callId);
        const record: ToolCallRecord = {
            ...startedRecord,
            completedAt,
            ...(error === undefined ? {} : { error }),
            ...(result?.exitCode === undefined ? {} : { exitCode: result.exitCode }),
            instance: this.#instanceName,
            ...(result?.output === undefined ? {} : { output: result.output }),
            status,
            ...(result?.stderrBytes === undefined ? {} : { stderrBytes: result.stderrBytes }),
            ...(result?.stdoutBytes === undefined ? {} : { stdoutBytes: result.stdoutBytes }),
            ...(result?.termSignal === undefined ? {} : { termSignal: result.termSignal }),
            ...(result?.termination === undefined ? {} : { termination: result.termination })
        };

        await this.#store.append(record);
        this.#activeCalls.delete(callId);
        return record;
    }

    async #finishNonRunning(
        callId: string,
        error: string,
        completedAt: string,
        status: Extract<ToolCallRecord["status"], "denied" | "expired" | "queueTimeout" | "cancelled">,
        decision?: ToolCallApprovalDecision
    ): Promise<ToolCallRecord> {
        await this.#initialize();
        const startedRecord = this.#readActiveCall(callId);
        const record: ToolCallRecord = {
            ...startedRecord,
            completedAt,
            ...(decision === undefined ? {} : { decision }),
            error,
            instance: this.#instanceName,
            status
        };

        await this.#store.append(record);
        this.#activeCalls.delete(callId);
        return record;
    }
}

function sliceByFilters(records: ToolCallRecord[], query: ToolCallQuery): ToolCallRecord[] {
    const callIds = query.callIds === undefined ? undefined : new Set(query.callIds);
    return records.filter((record) => {
        if (callIds !== undefined && !callIds.has(record.callId)) {
            return false;
        }

        if (query.ctxId !== undefined && record.ctxId !== query.ctxId) {
            return false;
        }

        if (query.source !== undefined && record.source !== query.source) {
            return false;
        }

        if (query.status !== undefined && record.status !== query.status) {
            return false;
        }

        if (query.toolName !== undefined && record.toolName !== query.toolName) {
            return false;
        }

        return true;
    });
}

function sliceByCursor(records: ToolCallRecord[], query: ToolCallQuery): ToolCallRecord[] {
    const startIndex = query.after === undefined ? 0 : findCursorIndex(records, query.after) + 1;
    const endIndex = query.before === undefined ? records.length : findCursorIndex(records, query.before);

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

function applyLimit(records: ToolCallRecord[], query: ToolCallQuery): ToolCallRecord[] {
    if (query.limit === undefined) {
        return records;
    }

    if (query.after !== undefined) {
        return records.slice(0, query.limit);
    }

    return records.slice(-query.limit);
}

function canReadTail(query: ToolCallQuery): query is ToolCallQuery & { limit: number } {
    return query.limit !== undefined &&
        query.after === undefined &&
        query.before === undefined &&
        query.callIds === undefined &&
        query.ctxId === undefined &&
        query.source === undefined &&
        query.status === undefined &&
        query.toolName === undefined;
}

function canReadQuery(query: ToolCallQuery): boolean {
    return !hasCursor(query) && (
        query.limit !== undefined ||
        query.callIds !== undefined ||
        query.ctxId !== undefined ||
        query.source !== undefined ||
        query.status !== undefined ||
        query.toolName !== undefined
    );
}

function hasCursor(query: ToolCallQuery): boolean {
    return query.after !== undefined || query.before !== undefined;
}

function isFailureInWindow(record: ToolCallRecord, sinceMs: number, untilMs: number): boolean {
    if (record.status !== "failed" && record.status !== "queueTimeout") return false;
    const timestamp = failureTimestamp(record);
    return Number.isFinite(timestamp) && timestamp >= sinceMs && timestamp <= untilMs;
}

function failureTimestamp(record: ToolCallRecord): number {
    return Date.parse(record.completedAt ?? record.startedAt);
}

function findCursorIndex(records: ToolCallRecord[], callId: string): number {
    return records.findIndex((record) => record.callId === callId);
}
