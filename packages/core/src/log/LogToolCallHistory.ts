import {
    errorCodes,
    type CommandResult,
    type InstanceName,
    type ToolCallContext,
    type ToolCallRecord
} from "@portable-devshell/shared";

import { JsonlStore } from "./store/LogStoreJsonl.js";
import type { LogQuery } from "./LogQuery.js";

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
        args: string[];
        callId: string;
        requestId?: string;
        sessionId?: string;
        source: ToolCallContext["source"];
        startedAt: string;
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
        args: string[],
        context: ToolCallContext,
        startedAt: string
    ): Promise<void> {
        await this.#initialize();

        if (this.#activeCall !== undefined) {
            throw new InstanceBusyError(this.#instanceName);
        }

        this.#activeCall = {
            args,
            callId,
            requestId: context.requestId,
            sessionId: context.sessionId,
            source: context.source,
            startedAt,
            toolName
        };
    }

    async completed(callId: string, result: CommandResult, finishedAt: string): Promise<ToolCallRecord> {
        await this.#initialize();
        this.#assertActiveCall(callId);

        const startedRecord = this.#readActiveCall(callId);
        const record: ToolCallRecord = {
            ...startedRecord,
            instanceName: this.#instanceName,
            finishedAt,
            result,
            status: "completed"
        };

        this.#activeCall = undefined;
        await this.#store.append(record);
        return record;
    }

    async failed(callId: string, errorCode: string, finishedAt: string, result?: CommandResult): Promise<ToolCallRecord> {
        await this.#initialize();
        this.#assertActiveCall(callId);

        const startedRecord = this.#readActiveCall(callId);
        const record: ToolCallRecord = {
            ...startedRecord,
            errorCode,
            finishedAt,
            instanceName: this.#instanceName,
            result,
            status: "failed"
        };

        this.#activeCall = undefined;
        await this.#store.append(record);
        return record;
    }

    async read(query: LogQuery = {}): Promise<ToolCallRecord[]> {
        await this.#initialize();
        const records = await this.#store.readAll();
        const fromSeq = query.fromSeq ?? 1;
        const filtered = records.filter((_: ToolCallRecord, index: number) => index + 1 >= fromSeq);

        if (query.limit === undefined) {
            return filtered;
        }

        return filtered.slice(0, query.limit);
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
}
