import {
    errorCodes,
    type InstanceName,
    type ToolCallContext,
    type ToolCallQuery,
    type ToolCallApprovalDecision,
    type ToolCallRecord
} from "@portable-devshell/shared";

import { JsonlStore } from "./store/LogStoreJsonl.js";

export class InstanceBusyError extends Error {
    readonly code = errorCodes.coreInstanceBusy;

    constructor(instanceName: string) {
        super(`Instance ${instanceName} is busy.`);
    }
}

export class ToolCallHistory {
    readonly #instanceName: InstanceName;
    readonly #store: JsonlStore<ToolCallRecord>;
    #activeCall?: {
        approvalId?: string;
        callId: string;
        decision?: ToolCallApprovalDecision;
        inputSummary: string;
        requestId?: string;
        sessionId?: string;
        source: ToolCallContext["source"];
        startedAt: string;
        status: ToolCallRecord["status"];
        toolName: string;
    };
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
        status: ToolCallRecord["status"] = "running"
    ): Promise<void> {
        await this.#initialize();

        if (this.#activeCall !== undefined) {
            throw new InstanceBusyError(this.#instanceName);
        }

        this.#activeCall = {
            callId,
            inputSummary,
            requestId: context.requestId,
            sessionId: context.sessionId,
            source: context.source,
            startedAt,
            status,
            toolName
        };
    }

    async pendingApproval(callId: string, approvalId: string): Promise<void> {
        await this.#initialize();
        this.#assertActiveCall(callId);
        if (this.#activeCall !== undefined) {
            this.#activeCall.approvalId = approvalId;
            this.#activeCall.status = "pendingApproval";
        }
    }

    async running(callId: string, decision?: ToolCallApprovalDecision): Promise<void> {
        await this.#initialize();
        this.#assertActiveCall(callId);
        if (this.#activeCall !== undefined) {
            this.#activeCall.status = "running";
            this.#activeCall.decision = decision;
        }
    }

    async completed(
        callId: string,
        result: { exitCode: number | null; stderrBytes: number; stdoutBytes: number; timedOut: boolean },
        completedAt: string
    ): Promise<ToolCallRecord> {
        await this.#initialize();
        this.#assertActiveCall(callId);

        const startedRecord = this.#readActiveCall(callId);
        const record: ToolCallRecord = {
            ...startedRecord,
            completedAt,
            exitCode: result.exitCode,
            instance: this.#instanceName,
            status: "completed",
            stderrBytes: result.stderrBytes,
            stdoutBytes: result.stdoutBytes,
            timedOut: result.timedOut
        };

        this.#activeCall = undefined;
        await this.#store.append(record);
        return record;
    }

    async failed(
        callId: string,
        error: string,
        completedAt: string,
        result?: { exitCode?: number | null; stderrBytes?: number; stdoutBytes?: number; timedOut: boolean }
    ): Promise<ToolCallRecord> {
        await this.#initialize();
        this.#assertActiveCall(callId);

        const startedRecord = this.#readActiveCall(callId);
        const record: ToolCallRecord = {
            ...startedRecord,
            completedAt,
            error,
            ...(result?.exitCode === undefined ? {} : { exitCode: result.exitCode }),
            instance: this.#instanceName,
            status: "failed",
            ...(result?.stderrBytes === undefined ? {} : { stderrBytes: result.stderrBytes }),
            ...(result?.stdoutBytes === undefined ? {} : { stdoutBytes: result.stdoutBytes }),
            timedOut: result?.timedOut === true
        };

        this.#activeCall = undefined;
        await this.#store.append(record);
        return record;
    }

    async denied(callId: string, error: string, completedAt: string): Promise<ToolCallRecord> {
        return await this.#finishNonRunning(callId, error, completedAt, "denied", "denied");
    }

    async expired(callId: string, error: string, completedAt: string): Promise<ToolCallRecord> {
        return await this.#finishNonRunning(callId, error, completedAt, "expired", "expired");
    }

    async read(query: ToolCallQuery = {}): Promise<ToolCallRecord[]> {
        await this.#initialize();
        const records = await this.#store.readAll();
        const activeRecord = this.#readActiveRecord();
        const filtered = sliceByFilters(sliceByCursor(activeRecord === undefined ? records : [...records, activeRecord], query), query);
        return applyLimit(filtered, query);
    }

    async #initialize(): Promise<void> {
        if (this.#initialized) {
            return;
        }
        this.#initialized = true;
    }

    #assertActiveCall(callId: string): void {
        if (this.#activeCall?.callId !== callId) {
            throw new Error(`Active tool call ${callId} was not found.`);
        }
    }

    #readActiveCall(callId: string) {
        this.#assertActiveCall(callId);
        if (this.#activeCall === undefined) {
            throw new Error(`Active tool call ${callId} was not found.`);
        }

        return this.#activeCall;
    }

    #readActiveRecord(): ToolCallRecord | undefined {
        if (this.#activeCall === undefined) {
            return undefined;
        }

        return {
            ...this.#activeCall,
            instance: this.#instanceName,
            timedOut: false
        };
    }

    async #finishNonRunning(
        callId: string,
        error: string,
        completedAt: string,
        status: Extract<ToolCallRecord["status"], "denied" | "expired">,
        decision: ToolCallApprovalDecision
    ): Promise<ToolCallRecord> {
        await this.#initialize();
        this.#assertActiveCall(callId);

        const startedRecord = this.#readActiveCall(callId);
        const record: ToolCallRecord = {
            ...startedRecord,
            completedAt,
            decision,
            error,
            instance: this.#instanceName,
            status,
            timedOut: false
        };

        this.#activeCall = undefined;
        await this.#store.append(record);
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
