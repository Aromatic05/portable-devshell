import {
    CONTROL_PROTOCOL_VERSION,
    STREAM_GAP_CODE,
    Endpoint,
    connectControlChannel,
    createApprovalTransport,
    createCliCommandTransport,
    createConfigTransport,
    createContextTransport,
    createDebugTransport,
    createExtensionRuntimeTransport,
    createInstanceManagementTransport,
    createMcpControlTransport,
    createMessageTransport,
    createOverviewTransport,
    createRemoteError,
    createReverseConnectionTransport,
    createRuntimeTransport,
    createServiceTransport,
    createTodoTransport,
    createToolTransport,
    type ApprovalTransport,
    type ConfigTransport,
    type ContextTransport,
    type ControlChannelOptions,
    type DebugTransport,
    type ExtensionRuntimeTransport,
    type InstanceEvent,
    type InstanceEventStreamPort,
    type InstanceManagementTransport,
    type InstanceStreamMessage,
    type JsonValue,
    type McpControlTransport,
    type MessageTransport,
    type OverviewTransport,
    type ReverseConnectionTransport,
    type RuntimeTransport,
    type ServiceTransport,
    type TodoTransport,
    type ToolTransport,
} from "@portable-devshell/shared";

import { CliRenderError } from "../app/Failure.js";
import { createCliRuntimeAdapter, type CliClientRuntime } from "./Runtime.js";
import { createCliCommandAdapter, type CliClientCommand } from "./Command.js";

export interface CliClientOptions extends ControlChannelOptions {}

export type CliClientTodo = Omit<TodoTransport, "subscribe"> & {
    subscribe(instance: string, fromSeq: number): Promise<CliClientEventStream>;
};

/**
 * CLI-local dependency surface. It carries the explicitly named domain
 * transports the stateless CLI composes over one shared Endpoint; it holds no
 * aggregate snapshot or subscription policy.
 */
export interface CliClients {
    approval: ApprovalTransport;
    cli: CliClientCommand;
    config: ConfigTransport;
    context: ContextTransport;
    contextMessage: MessageTransport;
    debug: DebugTransport;
    extension: ExtensionRuntimeTransport;
    instance: InstanceManagementTransport;
    mcp: McpControlTransport;
    overview: OverviewTransport;
    reverse: ReverseConnectionTransport;
    runtime: CliClientRuntime;
    service: ServiceTransport;
    todo: CliClientTodo;
    tool: ToolTransport;
    close(): void;
    reconnect(): Promise<void>;
}

export function createCliClients(options: CliClientOptions = {}): CliClients {
    const endpoint = new Endpoint({
        connectChannel: (signal) => connectControlChannel(options, signal),
    });
    const runtime: RuntimeTransport = createRuntimeTransport(endpoint);
    const todo = createTodoTransport(endpoint);
    return {
        approval: createApprovalTransport(endpoint),
        cli: createCliCommandAdapter(
            endpoint,
            createCliCommandTransport(endpoint),
        ),
        config: createConfigTransport(endpoint),
        context: createContextTransport(endpoint),
        contextMessage: createMessageTransport(endpoint, runtime),
        debug: createDebugTransport(endpoint),
        extension: createExtensionRuntimeTransport(endpoint),
        instance: createInstanceManagementTransport(endpoint),
        mcp: createMcpControlTransport(endpoint),
        overview: createOverviewTransport(endpoint),
        reverse: createReverseConnectionTransport(endpoint),
        runtime: createCliRuntimeAdapter(endpoint, runtime),
        service: createServiceTransport(endpoint, { clientKind: "cli" }),
        todo: {
            delete: todo.delete,
            get: todo.get,
            subscribe: async (instance, fromSeq) =>
                new CliClientEventStream(
                    await todo.subscribe(instance, fromSeq),
                ),
        },
        tool: createToolTransport(endpoint),
        close: () => endpoint.close(),
        reconnect: async () => await endpoint.reconnect(),
    };
}

export async function negotiateCliControl(clients: CliClients): Promise<void> {
    const hello = await clients.service.hello();
    if (hello.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
        throw new CliRenderError(
            "control.protocolVersionMismatch",
            `Incompatible control protocol version: ${hello.protocolVersion}.`,
        );
    }
}

export class CliClientEventStream {
    readonly #stream: InstanceEventStreamPort;
    #closed = false;

    constructor(stream: InstanceEventStreamPort) {
        this.#stream = stream;
    }

    async nextEvent(): Promise<InstanceEvent> {
        const message = await this.#stream.next();
        if (message.kind === "event") return message.event;
        if (message.kind === "gap") {
            throw createRemoteError({
                code: STREAM_GAP_CODE,
                message:
                    "Requested event sequence is no longer available. Pull a fresh snapshot.",
                retryable: true,
                details: gapDetails(message),
            });
        }
        if (message.error !== undefined) throw message.error;
        throw new Error("control stream completed");
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#stream.close();
    }
}

function gapDetails(
    message: Extract<InstanceStreamMessage, { kind: "gap" }>,
): JsonValue {
    return (
        message.details ?? {
            latestSeq: message.gap.lastSeq,
            oldestAvailableSeq: message.gap.nextSeq,
            requestedFromSeq: message.gap.fromSeq,
        }
    );
}
