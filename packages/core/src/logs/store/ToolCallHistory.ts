import { errorCodes, type CommandResult, type InstanceName, type ToolCallRecord } from "@portable-devshell/shared";

import { JsonlStore } from "./JsonlStore.js";
import type { LogQuery } from "../query/LogQuery.js";

export class InstanceBusyError extends Error {
    readonly code = errorCodes.coreInstanceBusy;

    constructor(instanceName: string) {
        super(`Instance ${instanceName} is busy.`);
    }
}

export class ToolCallHistory {
    readonly #instanceName: InstanceName;
    readonly #store: JsonlStore<ToolCallRecord>;
    #activeCallId?: string;
    #initialized = false;

    constructor(instanceName: InstanceName, store: JsonlStore<ToolCallRecord>) {
        this.#instanceName = instanceName;
        this.#store = store;
    }

    async started(callId: string, toolName: string, args: string[], startedAt: string): Promise<ToolCallRecord> {
        await this.#initialize();

        if (this.#activeCallId !== undefined) {
            throw new InstanceBusyError(this.#instanceName);
        }

        this.#activeCallId = callId;

        const record: ToolCallRecord = {
            args,
            callId,
            instanceName: this.#instanceName,
            startedAt,
            status: "started",
            toolName
        };

        await this.#store.append(record);
        return record;
    }

    async completed(callId: string, result: CommandResult, finishedAt: string): Promise<ToolCallRecord> {
        await this.#initialize();
        this.#assertActiveCall(callId);

        const startedRecord = await this.#latestStarted(callId);
        const record: ToolCallRecord = {
            ...startedRecord,
            finishedAt,
            result,
            status: "completed"
        };

        this.#activeCallId = undefined;
        await this.#store.append(record);
        return record;
    }

    async failed(callId: string, errorCode: string, finishedAt: string, result?: CommandResult): Promise<ToolCallRecord> {
        await this.#initialize();
        this.#assertActiveCall(callId);

        const startedRecord = await this.#latestStarted(callId);
        const record: ToolCallRecord = {
            ...startedRecord,
            errorCode,
            finishedAt,
            result,
            status: "failed"
        };

        this.#activeCallId = undefined;
        await this.#store.append(record);
        return record;
    }

    async read(query: LogQuery = {}): Promise<ToolCallRecord[]> {
        await this.#initialize();
        const records = await this.#store.readAll();
        const fromSeq = query.fromSeq ?? 1;
        const filtered = records.filter((_, index) => index + 1 >= fromSeq);

        if (query.limit === undefined) {
            return filtered;
        }

        return filtered.slice(0, query.limit);
    }

    async #initialize(): Promise<void> {
        if (this.#initialized) {
            return;
        }

        const records = await this.#store.readAll();
        const startedRecords = new Map<string, ToolCallRecord>();

        for (const record of records) {
            if (record.status === "started") {
                startedRecords.set(record.callId, record);
                continue;
            }

            startedRecords.delete(record.callId);
        }

        this.#activeCallId = startedRecords.size === 1 ? [...startedRecords.keys()][0] : undefined;
        this.#initialized = true;
    }

    #assertActiveCall(callId: string): void {
        if (this.#activeCallId !== callId) {
            throw new Error(`Active tool call ${callId} was not found.`);
        }
    }

    async #latestStarted(callId: string): Promise<ToolCallRecord> {
        const records = await this.#store.readAll();
        const match = [...records].reverse().find((record) => record.callId === callId && record.status === "started");

        if (match === undefined) {
            throw new Error(`Started tool call ${callId} was not found.`);
        }

        return match;
    }
}
