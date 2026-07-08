import type { InstanceCreateDraft, InstanceCreateResult, InstanceCreateSchema, InstanceCreateSummary, JsonValue } from "@portable-devshell/shared";

import { CliControlConnection, type CliControlConnectionOptions } from "./CliControlConnection.js";
import { createControlTarget, createInstanceTarget, type CliControlEventEnvelope } from "./CliControlRequest.js";
import {
    asCommandResult,
    asInstanceList,
    asInstanceSnapshotEnvelope,
    asLogEntries,
    CliControlStream,
    type CliCommandResult,
    type CliInstanceListEntry,
    type CliInstanceLogEntry,
    type CliInstanceSnapshotEnvelope
} from "./CliControlStream.js";

export interface CliControlClientLike {
    callTool(instance: string, toolName: string, input: JsonValue): Promise<CliCommandResult>;
    createInstance(draft: InstanceCreateDraft): Promise<InstanceCreateResult>;
    getInstanceCreateSchema(): Promise<InstanceCreateSchema>;
    getSnapshot(instance: string): Promise<CliInstanceSnapshotEnvelope>;
    listInstances(): Promise<CliInstanceListEntry[]>;
    readLogs(instance: string, query?: { fromSeq?: number; limit?: number }): Promise<CliInstanceLogEntry[]>;
    refreshStatus(instance: string): Promise<CliInstanceSnapshotEnvelope>;
    startInstance(instance: string): Promise<CliInstanceSnapshotEnvelope["snapshot"]>;
    stopInstance(instance: string): Promise<CliInstanceSnapshotEnvelope["snapshot"]>;
    subscribe(instance: string, fromSeq: number): Promise<CliControlStream>;
    validateInstanceCreateDraft(draft: InstanceCreateDraft): Promise<InstanceCreateSummary>;
}

export class CliControlClient implements CliControlClientLike {
    readonly #connectionOptions: CliControlConnectionOptions;

    constructor(options: CliControlConnectionOptions = {}) {
        this.#connectionOptions = options;
    }

    async listInstances(): Promise<CliInstanceListEntry[]> {
        return asInstanceList(await this.#request("control.listInstances", createControlTarget()));
    }

    async getInstanceCreateSchema(): Promise<InstanceCreateSchema> {
        return (await this.#request("control.getInstanceCreateSchema", createControlTarget())) as unknown as InstanceCreateSchema;
    }

    async validateInstanceCreateDraft(draft: InstanceCreateDraft): Promise<InstanceCreateSummary> {
        return (await this.#request("control.validateInstanceCreateDraft", createControlTarget(), draft as unknown as JsonValue)) as unknown as InstanceCreateSummary;
    }

    async createInstance(draft: InstanceCreateDraft): Promise<InstanceCreateResult> {
        return (await this.#request("control.createInstance", createControlTarget(), draft as unknown as JsonValue)) as unknown as InstanceCreateResult;
    }

    async getSnapshot(instance: string): Promise<CliInstanceSnapshotEnvelope> {
        return asInstanceSnapshotEnvelope(await this.#request("instance.getSnapshot", createInstanceTarget(instance)));
    }

    async refreshStatus(instance: string): Promise<CliInstanceSnapshotEnvelope> {
        return asInstanceSnapshotEnvelope(await this.#request("instance.refreshStatus", createInstanceTarget(instance)));
    }

    async startInstance(instance: string): Promise<CliInstanceSnapshotEnvelope["snapshot"]> {
        return (await this.#request("instance.start", createInstanceTarget(instance))) as unknown as CliInstanceSnapshotEnvelope["snapshot"];
    }

    async stopInstance(instance: string): Promise<CliInstanceSnapshotEnvelope["snapshot"]> {
        return (await this.#request("instance.stop", createInstanceTarget(instance))) as unknown as CliInstanceSnapshotEnvelope["snapshot"];
    }

    async readLogs(instance: string, query?: { fromSeq?: number; limit?: number }): Promise<CliInstanceLogEntry[]> {
        return asLogEntries(await this.#request("instance.readLogs", createInstanceTarget(instance), query as JsonValue | undefined));
    }

    async callTool(instance: string, toolName: string, input: JsonValue): Promise<CliCommandResult> {
        return asCommandResult(
            await this.#request("instance.callTool", createInstanceTarget(instance), {
                input,
                toolName
            })
        );
    }

    async subscribe(instance: string, fromSeq: number): Promise<CliControlStream> {
        const connection = new CliControlConnection(this.#connectionOptions);
        const result = (await connection.request("instance.subscribe", createInstanceTarget(instance), { fromSeq })) as unknown as {
            events: CliControlEventEnvelope[];
            lastSeq: number;
        };

        return new CliControlStream(connection, result.events);
    }

    async #request(method: string, target: ReturnType<typeof createControlTarget> | ReturnType<typeof createInstanceTarget>, params?: JsonValue): Promise<JsonValue> {
        const connection = new CliControlConnection(this.#connectionOptions);

        try {
            return await connection.request(method, target, params);
        } finally {
            connection.close();
        }
    }
}
