import {
    asInstanceName,
    ClientConnection,
    controlClientModule,
    CONTROL_PROTOCOL_VERSION,
    createError,
    instanceClientModule,
    readClientSubscriptionEvents,
    type ApprovalDecisionValue,
    type ApprovalRequest,
    type ChannelProvider,
    type ClientEvent,
    type ClientStream,
    type ControlErrorBody,
    type ControlProtocolHelloRequest,
    type ControlProtocolHelloResponse,
    type InstanceEvent,
    type InstanceListEntry,
    type InstanceLogEntry,
    type InstanceRuntimeEnvelope,
    type InstanceSnapshot,
    type JsonValue,
    type OAuthApprovalDecision,
    type OAuthApprovalRequest,
} from "@portable-devshell/shared/browser";

import { BrowserWebSocketChannelProvider } from "../rpc/BrowserWebSocketChannelProvider.js";

export interface WebClients {
    close(): void;
    reconnect(): Promise<void>;
    service: {
        hello(): Promise<ControlProtocolHelloResponse>;
        status(): Promise<{ instanceCount: number; ok: boolean; pid?: number }>;
    };
    instance: { list(): Promise<InstanceListEntry[]> };
    runtime: {
        snapshot(instance: string): Promise<InstanceRuntimeEnvelope>;
        refresh(instance: string): Promise<InstanceRuntimeEnvelope>;
        readLogs(
            instance: string,
            query?: { fromSeq?: number; limit?: number },
        ): Promise<InstanceLogEntry[]>;
        stop(instance: string): Promise<InstanceSnapshot>;
        start(instance: string): Promise<InstanceSnapshot>;
        subscribe(instance: string, fromSeq: number): Promise<WebRuntimeStream>;
    };
    tool: {
        listApprovals(instance: string): Promise<ApprovalRequest[]>;
        getApproval(
            instance: string,
            approvalId: string,
        ): Promise<ApprovalRequest>;
        decideApproval(
            instance: string,
            approvalId: string,
            decision: ApprovalDecisionValue,
        ): Promise<ApprovalRequest>;
    };
    mcp: {
        listApprovals(): Promise<OAuthApprovalRequest[]>;
        decideApproval(
            approvalId: string,
            decision: OAuthApprovalDecision,
        ): Promise<OAuthApprovalRequest>;
    };
}

export class WebRuntimeStream {
    #initial: ClientEvent[];

    constructor(
        private readonly stream: ClientStream,
        acknowledgement: ClientEvent,
        instance: string,
    ) {
        this.#initial = readClientSubscriptionEvents(
            asInstanceName(instance),
            acknowledgement.payload,
        );
    }

    async next(): Promise<
        | { kind: "event"; event: InstanceEvent }
        | { kind: "gap" }
        | { kind: "closed" }
    > {
        const event = this.#initial.shift() ?? (await this.stream.nextEvent());
        if (event.name === "stream.gap") {
            return { kind: "gap" };
        }
        if (
            event.name === "stream.completed" ||
            event.name === "stream.cancelled"
        ) {
            return { kind: "closed" };
        }
        return { kind: "event", event: readInstanceEvent(event.payload) };
    }

    close(): void {
        this.stream.close();
    }
}

export function createWebClients(
    channelProvider: ChannelProvider = new BrowserWebSocketChannelProvider(),
): WebClients {
    const connection = new ClientConnection({
        channelProvider,
        mapError,
        mapRemoteError: (error) => createError(error),
        mode: "persistent",
        peer: "web",
    });
    const service = controlClientModule(connection, "service");
    const instance = controlClientModule(connection, "instance");
    const mcp = controlClientModule(connection, "mcp");
    const runtime = instanceClientModule(connection, "runtime");
    const tool = instanceClientModule(connection, "tool");

    return {
        close: () => connection.close(),
        reconnect: () => connection.reconnect(),
        service: {
            hello: () =>
                service.request<ControlProtocolHelloResponse>(
                    "hello",
                    helloRequest(),
                ),
            status: () => service.request("status"),
        },
        instance: { list: () => instance.request("list") },
        runtime: {
            snapshot: (name) => runtime.request(name, "snapshot"),
            refresh: (name) => runtime.request(name, "refresh"),
            readLogs: (name, query) => runtime.request(name, "readLogs", query),
            stop: (name) => runtime.request(name, "stop"),
            start: async (name) => {
                const opened = await runtime.openStream(name, "start");
                while (true) {
                    const event = await opened.stream.nextEvent();
                    if (event.name === "stream.completed") {
                        return readInstanceSnapshot(event.payload);
                    }
                    if (event.name === "stream.cancelled") {
                        connection.throwRemoteError(event.error);
                        throw new Error("Start cancelled.");
                    }
                }
            },
            subscribe: async (name, fromSeq) => {
                const opened = await runtime.openStream(name, "subscribe", {
                    fromSeq,
                });
                return new WebRuntimeStream(
                    opened.stream,
                    opened.acknowledgement,
                    name,
                );
            },
        },
        tool: {
            listApprovals: (name) => tool.request(name, "listApprovals"),
            getApproval: (name, approvalId) =>
                tool.request(name, "getApproval", { approvalId }),
            decideApproval: (name, approvalId, decision) =>
                tool.request(name, "decideApproval", { approvalId, decision }),
        },
        mcp: {
            listApprovals: () => mcp.request("listApprovals"),
            decideApproval: (approvalId, decision) =>
                mcp.request("decideApproval", { approvalId, decision }),
        },
    };
}

function helloRequest(): ControlProtocolHelloRequest {
    return {
        clientKind: "web",
        maxProtocolVersion: CONTROL_PROTOCOL_VERSION,
        minProtocolVersion: CONTROL_PROTOCOL_VERSION,
    };
}

function mapError(error: unknown): Error {
    if (isControlErrorBody(error)) {
        return createError(error);
    }
    return error instanceof Error ? error : new Error(String(error));
}

function isControlErrorBody(value: unknown): value is ControlErrorBody {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const body = value as Partial<ControlErrorBody>;
    return (
        typeof body.code === "string" &&
        typeof body.message === "string" &&
        typeof body.retryable === "boolean"
    );
}

function readInstanceEvent(payload: JsonValue | undefined): InstanceEvent {
    const value = record(payload, "Invalid runtime event.");
    if (
        typeof value.at !== "string" ||
        typeof value.instanceName !== "string" ||
        typeof value.seq !== "number" ||
        typeof value.type !== "string"
    ) {
        throw new Error("Invalid runtime event.");
    }
    return {
        at: value.at,
        ...(value.data === undefined ? {} : { data: value.data }),
        instanceName: asInstanceName(value.instanceName),
        seq: value.seq,
        type: value.type as InstanceEvent["type"],
    };
}

function readInstanceSnapshot(
    payload: JsonValue | undefined,
): InstanceSnapshot {
    const value = record(payload, "Invalid runtime snapshot.");
    if (
        typeof value.name !== "string" ||
        typeof value.lastSeq !== "number" ||
        typeof value.ready !== "boolean" ||
        !isOneOf(value.connectionState, [
            "connected",
            "connecting",
            "disconnected",
            "reconnecting",
            "failed",
        ]) ||
        !isOneOf(value.daemonState, [
            "running",
            "starting",
            "stopped",
            "stale",
            "stopping",
            "failed",
        ]) ||
        !isOneOf(value.status, [
            "ready",
            "running",
            "stale",
            "stopped",
            "failed",
        ])
    ) {
        throw new Error("Invalid runtime snapshot.");
    }
    return {
        connectionState: value.connectionState,
        daemonState: value.daemonState,
        lastSeq: value.lastSeq,
        name: asInstanceName(value.name),
        ready: value.ready,
        status: value.status,
    };
}

function record(
    value: JsonValue | undefined,
    error: string,
): Record<string, JsonValue> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(error);
    }
    return value;
}

function isOneOf<TValue extends string>(
    value: JsonValue | undefined,
    values: readonly TValue[],
): value is TValue {
    return typeof value === "string" && values.includes(value as TValue);
}
