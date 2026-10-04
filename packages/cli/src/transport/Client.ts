import {
    CONTROL_PROTOCOL_VERSION,
    STREAM_GAP_CODE,
    Endpoint,
    connectControlChannel,
    createApprovalTransport,
    createCliCommandTransport,
    createConfigTransport,
    createInstanceTransport,
    createContextTransport,
    createDebugTransport,
    createExtensionRuntimeTransport,
    createAuthTransport,
    createMessageTransport,
    createOverviewTransport,
    createRemoteError,
    createConnectionTransport,
    createProcessTransport,
    createServerTransport,
    createTaskTransport,
    createToolTransport,
    type ApprovalTransport,
    type ConfigTransport,
    type InstanceTransport,
    type ContextTransport,
    type ControlChannelOptions,
    type DebugTransport,
    type ExtensionRuntimeTransport,
    type InstanceEventRecord,
    type InstanceEventStreamPort,
    type JsonValue,
    type AuthTransport,
    type MessageTransport,
    type OverviewTransport,
    type ConnectionTransport,
    type ProcessTransport,
    type ServerTransport,
    type StreamMessage,
    type TaskEvent,
    type TaskTransport,
    type ToolTransport,
} from "@portable-devshell/shared";

import { CliRenderError } from "../app/Failure.js";
import { createCliRuntimeAdapter, type CliClientRuntime } from "./Runtime.js";
import { createCliCommandAdapter, type CliClientCommand } from "./Command.js";

export interface CliClientOptions extends ControlChannelOptions {}

export type CliClientTodo = Pick<TaskTransport, "deleteTodo" | "getTodo"> & {
    subscribe(
        instance: string,
        fromSeq: number,
    ): Promise<CliClientEventStream<TaskEvent>>;
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
    instance: InstanceTransport;
    mcp: AuthTransport;
    overview: OverviewTransport;
    reverse: ConnectionTransport;
    runtime: CliClientRuntime;
    server: ServerTransport;
    todo: CliClientTodo;
    tool: ToolTransport;
    close(): void;
    reconnect(): Promise<void>;
}

export function createCliClients(options: CliClientOptions = {}): CliClients {
    const endpoint = new Endpoint({
        connectChannel: (signal) => connectControlChannel(options, signal),
    });
    const runtime: ProcessTransport = createProcessTransport(endpoint);
    const task = createTaskTransport(endpoint);
    return {
        approval: createApprovalTransport(endpoint),
        cli: createCliCommandAdapter(
            endpoint,
            createCliCommandTransport(endpoint),
        ),
        config: createConfigTransport(endpoint),
        context: createContextTransport(endpoint),
        contextMessage: createMessageTransport(endpoint),
        debug: createDebugTransport(endpoint),
        extension: createExtensionRuntimeTransport(endpoint),
        instance: createInstanceTransport(endpoint),
        mcp: createAuthTransport(endpoint),
        overview: createOverviewTransport(endpoint),
        reverse: createConnectionTransport(endpoint),
        runtime: createCliRuntimeAdapter(endpoint, runtime),
        server: createServerTransport(endpoint, { clientKind: "cli" }),
        todo: {
            deleteTodo: task.deleteTodo,
            getTodo: task.getTodo,
            subscribe: async (instance, fromSeq) =>
                new CliClientEventStream(
                    await task.subscribe(instance, fromSeq),
                ),
        },
        tool: createToolTransport(endpoint),
        close: () => endpoint.close(),
        reconnect: async () => await endpoint.reconnect(),
    };
}

export async function negotiateCliControl(clients: CliClients): Promise<void> {
    const hello = await clients.server.hello();
    if (hello.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
        throw new CliRenderError(
            "control.protocolVersionMismatch",
            `Incompatible control protocol version: ${hello.protocolVersion}.`,
        );
    }
}

export class CliClientEventStream<
    Event extends InstanceEventRecord = InstanceEventRecord,
> {
    readonly #stream: InstanceEventStreamPort<Event>;
    #closed = false;

    constructor(stream: InstanceEventStreamPort<Event>) {
        this.#stream = stream;
    }

    async nextEvent(): Promise<Event> {
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

function gapDetails<Event>(
    message: Extract<StreamMessage<Event>, { kind: "gap" }>,
): JsonValue {
    return (
        message.details ?? {
            latestSeq: message.gap.lastSeq,
            oldestAvailableSeq: message.gap.nextSeq,
            requestedFromSeq: message.gap.fromSeq,
        }
    );
}
