import {
    CONTROL_PROTOCOL_VERSION,
    ClientConnection,
    connectControlClientChannel,
    createControlClients,
    type ControlClientChannelOptions,
    type ControlClients,
    type ControlErrorBody,
} from "@portable-devshell/shared";

import { CliRenderError } from "../app/Failure.js";
import {
    createCliRuntimeAdapter,
    type CliClientRuntime,
} from "./Runtime.js";
import {
    createCliCommandAdapter,
    type CliClientCommand
} from "./Command.js";

export interface CliClientOptions extends ControlClientChannelOptions {}

export type CliClientTodo = Omit<ControlClients["todo"], "subscribe"> & {
    subscribe(instance: string, fromSeq: number): Promise<CliClientEventStream>;
};

export type CliClients = Omit<ControlClients, "cli" | "runtime" | "todo"> & {
    cli: CliClientCommand;
    close?(): void;
    reconnect?(): Promise<void>;
    runtime: CliClientRuntime;
    todo: CliClientTodo;
};

export function createCliClients(options: CliClientOptions = {}): CliClients {
    const connection = new ClientConnection({
        connectChannel: (signal) => connectControlClientChannel(options, signal),
        mode: "persistent",
        peer: "cli",
        mapError: toClientError,
        mapRemoteError: toRemoteError,
    });
    const clients = createControlClients(connection, { clientKind: "cli" });
    return {
        ...clients,
        cli: createCliCommandAdapter(connection, clients.cli),
        close: () => connection.close(),
        reconnect: async () => await connection.reconnect(),
        runtime: createCliRuntimeAdapter(connection, clients.runtime),
        todo: {
            delete: clients.todo.delete,
            get: clients.todo.get,
            subscribe: async (instance, fromSeq) =>
                new CliClientEventStream(
                    await clients.todo.subscribe(instance, fromSeq),
                ),
        },
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

function toRemoteError(error: ControlErrorBody): Error {
    return new CliRenderError(error.code, error.message, {
        cause: error.cause,
        details: error.details,
        retryable: error.retryable,
    });
}

function toClientError(error: unknown): Error {
    if (error instanceof CliRenderError) return error;
    if (typeof error === "object" && error !== null && "code" in error) {
        const code = String(error.code);
        if (code === "ENOENT" || code === "ECONNREFUSED") {
            return new CliRenderError(
                "control.notRunning",
                "control server is not running.",
            );
        }
    }
    return error instanceof Error
        ? error
        : new CliRenderError("control.notRunning", String(error));
}

import {
    createError,
    errorCodes,
    type InstanceEvent,
    type InstanceEventStreamPort,
    type InstanceStreamMessage,
    type JsonValue,
} from "@portable-devshell/shared";

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
            throw createError({
                code: errorCodes.streamGap,
                message: "Requested event sequence is no longer available. Pull a fresh snapshot.",
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
    return message.details ?? {
        ...(message.fromSeq === undefined ? {} : { fromSeq: message.fromSeq }),
        ...(message.lastSeq === undefined ? {} : { lastSeq: message.lastSeq }),
        ...(message.nextSeq === undefined ? {} : { nextSeq: message.nextSeq }),
    };
}
