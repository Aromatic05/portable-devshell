import {
    ProtocolControlRpcClient,
    type ArtifactShareInput,
    type ArtifactShareResult,
    type ArtifactShareRevokeResult,
    type ArtifactTransferRecord,
    type ArtifactTransferResult,
    type ArtifactTransferStartInput,
    type InstanceCreateDraft,
    type InstanceCreateResult,
    type InstanceCreateSchema,
    type InstanceCreateSummary,
    type JsonValue,
    type ReverseDeviceCodeResult,
    type TodoRpcEnvelope,
    type ToolCallQuery,
    type ToolCallRecord
} from "@portable-devshell/shared";

import {
    createCliControlConnection,
    type CliControlConnection,
    type CliControlConnectionOptions
} from "./CliControlConnection.js";
import {
    CliControlStream,
    type CliInstanceListEntry,
    type CliInstanceLogEntry,
    type CliInstanceSnapshotEnvelope
} from "./CliControlStream.js";

export interface CliControlTerminalRelay {
    input: NodeJS.ReadableStream;
    output: { write(chunk: string): void };
}

export interface CliControlClientLike {
    callTool(instance: string, toolName: string, input: JsonValue): Promise<JsonValue>;
    createInstance(draft: InstanceCreateDraft): Promise<InstanceCreateResult>;
    createReverseDeviceCode(instance: string): Promise<ReverseDeviceCodeResult>;
    getInstanceCreateSchema(): Promise<InstanceCreateSchema>;
    getSnapshot(instance: string): Promise<CliInstanceSnapshotEnvelope>;
    getTodo(instance: string): Promise<TodoRpcEnvelope>;
    listInstances(): Promise<CliInstanceListEntry[]>;
    readLogs(instance: string, query?: { fromSeq?: number; limit?: number }): Promise<CliInstanceLogEntry[]>;
    readToolCalls(instance: string, query?: ToolCallQuery): Promise<ToolCallRecord[]>;
    revokeReverseDeviceToken(instance: string): Promise<{ instance: string; revoked: true }>;
    rotateReverseDeviceToken(instance: string): Promise<{ deviceToken: string; instance: string }>;
    refreshStatus(instance: string): Promise<CliInstanceSnapshotEnvelope>;
    startInstance(instance: string, relay?: CliControlTerminalRelay): Promise<CliInstanceSnapshotEnvelope["snapshot"]>;
    stopInstance(instance: string): Promise<CliInstanceSnapshotEnvelope["snapshot"]>;
    subscribe(instance: string, fromSeq: number): Promise<CliControlStream>;
    subscribeTodo(instance: string, fromSeq: number): Promise<CliControlStream>;
    validateInstanceCreateDraft(draft: InstanceCreateDraft): Promise<InstanceCreateSummary>;
    cancelArtifactTransfer?(transferId: string): Promise<ArtifactTransferResult>;
    createArtifactShare?(defaultInstance: string, input: ArtifactShareInput): Promise<ArtifactShareResult>;
    getArtifactTransfer?(transferId: string): Promise<ArtifactTransferRecord>;
    listArtifactShares?(): Promise<ArtifactShareResult[]>;
    listArtifactTransfers?(): Promise<ArtifactTransferRecord[]>;
    revokeArtifactShare?(shareId: string): Promise<ArtifactShareRevokeResult>;
    startArtifactTransfer?(defaultInstance: string, input: ArtifactTransferStartInput): Promise<ArtifactTransferResult>;
}

export class CliControlClient extends ProtocolControlRpcClient<CliControlConnection> implements CliControlClientLike {
    constructor(options: CliControlConnectionOptions = {}) {
        super(() => createCliControlConnection(options));
    }

    async startInstance(instance: string, relay?: CliControlTerminalRelay): Promise<CliInstanceSnapshotEnvelope["snapshot"]> {
        if (relay === undefined) {
            return await this.startInstanceRequest(instance);
        }

        const connection = this.createConnection();
        const restoreTerminal = enableRawRelayMode(relay.input);
        let requestId: string | undefined;
        const cleanup = attachRelayInput(relay.input, connection, () => requestId);

        try {
            return await connection.requestWithRelay("instance.start", { instance: instance as never, kind: "instance" }, {
                onOutput: (chunk) => relay.output.write(chunk),
                onRequestId: (value) => { requestId = value; }
            });
        } finally {
            cleanup();
            restoreTerminal();
            connection.close();
        }
    }

    async subscribe(instance: string, fromSeq: number): Promise<CliControlStream> {
        const { connection, events } = await this.openSubscription("instance.subscribe", instance, fromSeq);
        return new CliControlStream(connection, events);
    }

    async subscribeTodo(instance: string, fromSeq: number): Promise<CliControlStream> {
        const { connection, events } = await this.openSubscription("instance.todo.subscribe", instance, fromSeq);
        return new CliControlStream(connection, events);
    }
}

function attachRelayInput(
    input: NodeJS.ReadableStream,
    connection: CliControlConnection,
    getRequestId: () => string | undefined
): () => void {
    const onData = (chunk: string | Buffer) => {
        const requestId = getRequestId();
        if (requestId !== undefined) {
            void connection.sendRelayInput(requestId, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
    };
    const onEnd = () => {
        const requestId = getRequestId();
        if (requestId !== undefined) {
            void connection.sendRelayEof(requestId);
        }
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
    return () => input.setRawMode(previous === true);
}

function isRawModeCapable(
    input: NodeJS.ReadableStream
): input is NodeJS.ReadableStream & { isRaw?: boolean; isTTY?: boolean; setRawMode(mode: boolean): void } {
    return typeof input === "object" && input !== null && "setRawMode" in input && typeof input.setRawMode === "function";
}
