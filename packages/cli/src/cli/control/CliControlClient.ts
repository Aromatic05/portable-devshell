import type {
    ControlEventEnvelope,
    InstanceCreateDraft,
    InstanceCreateResult,
    InstanceCreateSchema,
    InstanceCreateSummary,
    JsonValue,
    ToolCallQuery,
    ToolCallRecord,
    TodoRpcEnvelope
} from "@portable-devshell/shared";

import { CliControlConnection, type CliControlConnectionOptions } from "./CliControlConnection.js";
import { createControlTarget, createInstanceTarget } from "./CliControlRequest.js";
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

export interface CliControlTerminalRelay {
    input: NodeJS.ReadableStream;
    output: { write(chunk: string): void };
}

export interface CliControlClientLike {
    callTool(instance: string, toolName: string, input: JsonValue): Promise<CliCommandResult>;
    createInstance(draft: InstanceCreateDraft): Promise<InstanceCreateResult>;
    getInstanceCreateSchema(): Promise<InstanceCreateSchema>;
    getSnapshot(instance: string): Promise<CliInstanceSnapshotEnvelope>;
    getTodo(instance: string): Promise<TodoRpcEnvelope>;
    listInstances(): Promise<CliInstanceListEntry[]>;
    readLogs(instance: string, query?: { fromSeq?: number; limit?: number }): Promise<CliInstanceLogEntry[]>;
    readToolCalls(instance: string, query?: ToolCallQuery): Promise<ToolCallRecord[]>;
    refreshStatus(instance: string): Promise<CliInstanceSnapshotEnvelope>;
    startInstance(instance: string, relay?: CliControlTerminalRelay): Promise<CliInstanceSnapshotEnvelope["snapshot"]>;
    stopInstance(instance: string): Promise<CliInstanceSnapshotEnvelope["snapshot"]>;
    subscribe(instance: string, fromSeq: number): Promise<CliControlStream>;
    subscribeTodo(instance: string, fromSeq: number): Promise<CliControlStream>;
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

    async getTodo(instance: string): Promise<TodoRpcEnvelope> {
        return (await this.#request("instance.todo.get", createInstanceTarget(instance))) as unknown as TodoRpcEnvelope;
    }

    async refreshStatus(instance: string): Promise<CliInstanceSnapshotEnvelope> {
        return asInstanceSnapshotEnvelope(await this.#request("instance.refreshStatus", createInstanceTarget(instance)));
    }

    async startInstance(instance: string, relay?: CliControlTerminalRelay): Promise<CliInstanceSnapshotEnvelope["snapshot"]> {
        if (relay === undefined) {
            return (await this.#request("instance.start", createInstanceTarget(instance))) as unknown as CliInstanceSnapshotEnvelope["snapshot"];
        }

        const connection = new CliControlConnection(this.#connectionOptions);
        const restoreTerminal = enableRawRelayMode(relay.input);
        let requestId: string | undefined;
        const cleanup = attachRelayInput(relay.input, connection, () => requestId);

        try {
            return (await connection.requestWithRelay("instance.start", createInstanceTarget(instance), {
                onOutput: (chunk) => {
                    relay.output.write(chunk);
                },
                onRequestId: (value) => {
                    requestId = value;
                }
            })) as unknown as CliInstanceSnapshotEnvelope["snapshot"];
        } finally {
            cleanup();
            restoreTerminal();
            connection.close();
        }
    }

    async stopInstance(instance: string): Promise<CliInstanceSnapshotEnvelope["snapshot"]> {
        return (await this.#request("instance.stop", createInstanceTarget(instance))) as unknown as CliInstanceSnapshotEnvelope["snapshot"];
    }

    async readLogs(instance: string, query?: { fromSeq?: number; limit?: number }): Promise<CliInstanceLogEntry[]> {
        return asLogEntries(await this.#request("instance.readLogs", createInstanceTarget(instance), query as JsonValue | undefined));
    }

    async readToolCalls(instance: string, query?: ToolCallQuery): Promise<ToolCallRecord[]> {
        return (await this.#request("instance.readToolCalls", createInstanceTarget(instance), query as JsonValue | undefined)) as unknown as ToolCallRecord[];
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
            events: ControlEventEnvelope[];
            lastSeq: number;
        };

        return new CliControlStream(connection, result.events);
    }


    async subscribeTodo(instance: string, fromSeq: number): Promise<CliControlStream> {
        const connection = new CliControlConnection(this.#connectionOptions);
        const result = (await connection.request("instance.todo.subscribe", createInstanceTarget(instance), { fromSeq })) as unknown as {
            events: ControlEventEnvelope[];
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

function attachRelayInput(
    input: NodeJS.ReadableStream,
    connection: CliControlConnection,
    getRequestId: () => string | undefined
): () => void {
    const onData = (chunk: string | Buffer) => {
        const requestId = getRequestId();
        if (requestId === undefined) {
            return;
        }

        void connection.sendRelayInput(requestId, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const onEnd = () => {
        const requestId = getRequestId();
        if (requestId === undefined) {
            return;
        }

        void connection.sendRelayEof(requestId);
    };

    input.on("data", onData);
    input.once("end", onEnd);

    return () => {
        input.off("data", onData);
        input.off("end", onEnd);
    };
}

function enableRawRelayMode(input: NodeJS.ReadableStream): () => void {
    if (!isRawModeCapable(input) || input.isTTY !== true) {
        return () => undefined;
    }

    const previous = input.isRaw;
    input.setRawMode(true);

    return () => {
        input.setRawMode(previous === true);
    };
}

function isRawModeCapable(
    input: NodeJS.ReadableStream
): input is NodeJS.ReadableStream & { isRaw?: boolean; isTTY?: boolean; setRawMode(mode: boolean): void } {
    return typeof input === "object" && input !== null && "setRawMode" in input && typeof input.setRawMode === "function";
}
