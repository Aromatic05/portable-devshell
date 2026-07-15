import {
    type InstanceName,
    type JsonValue,
    type ToolCallContext,
    type ToolCallQuery,
    type ToolCallApprovalDecision,
    type ToolCallAssociation,
    type ToolCallRecord
} from "@portable-devshell/shared";

import { JsonlStore } from "./store/LogStoreJsonl.js";

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
}

export class ToolCallHistory {
    readonly #instanceName: InstanceName;
    readonly #store: JsonlStore<ToolCallRecord>;
    readonly #activeCalls = new Map<string, ActiveToolCall>();
    #initialized = false;

    constructor(instanceName: InstanceName, store: JsonlStore<ToolCallRecord>) {
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
            toolName
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
        result?: { exitCode?: number | null; stderrBytes?: number; stdoutBytes?: number; termSignal?: number; termination?: "exited" | "signaled" | "timeout" }
    ): Promise<ToolCallRecord> {
        return await this.#finishRunning(callId, completedAt, "completed", undefined, result);
    }

    async failed(
        callId: string,
        error: string,
        completedAt: string,
        result?: { exitCode?: number | null; stderrBytes?: number; stdoutBytes?: number; termSignal?: number; termination?: "exited" | "signaled" | "timeout" }
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

    async read(query: ToolCallQuery = {}): Promise<ToolCallRecord[]> {
        await this.#initialize();
        const records = await this.#store.readAll();
        const activeRecords = this.#readActiveRecords();
        const filtered = sliceByFilters(sliceByCursor([...records, ...activeRecords], query), query);
        return applyLimit(filtered, query);
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
        result?: { exitCode?: number | null; stderrBytes?: number; stdoutBytes?: number; termSignal?: number; termination?: "exited" | "signaled" | "timeout" }
    ): Promise<ToolCallRecord> {
        await this.#initialize();
        const startedRecord = this.#readActiveCall(callId);
        const record: ToolCallRecord = {
            ...startedRecord,
            completedAt,
            ...(error === undefined ? {} : { error }),
            ...(result?.exitCode === undefined ? {} : { exitCode: result.exitCode }),
            instance: this.#instanceName,
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
    return records.filter((record) => {
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

function findCursorIndex(records: ToolCallRecord[], callId: string): number {
    return records.findIndex((record) => record.callId === callId);
}
