// Thin typed terminal transport. RPC operations cover session discovery and
// lifecycle; attach opens the bidirectional stream and exposes it as a typed
// TerminalAttachment (seed/output/ack plus input and resize).

import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import type { MessageStream } from "../../transport/packet/Stream.js";
import type { JsonValue } from "../../types/Json.js";
import type { EventStreamEnvelope } from "../../client/Stream.js";
import type {
    TerminalAttachInput,
    TerminalExitEvent,
    TerminalOpenInput,
    TerminalOpenResult,
    TerminalOutputFrame,
    TerminalSessionDescriptor,
    TerminalSessionState,
    TerminalStreamCommandIdentity,
    TerminalStreamMessage,
    TerminalVersionedIdentity,
} from "./Model.js";

const TERMINAL_PORT = "terminal";

export interface TerminalAttachment {
    ack(identity: TerminalVersionedIdentity, throughSeq: number): Promise<void>;
    close(): void;
    next(): Promise<TerminalStreamMessage>;
    sendInput(
        data: string,
        command: TerminalStreamCommandIdentity,
    ): Promise<void>;
    sendResize(
        cols: number,
        rows: number,
        command: TerminalStreamCommandIdentity,
    ): Promise<void>;
}

export interface TerminalTransport {
    attach(input: TerminalAttachInput): Promise<TerminalAttachment>;
    get(
        identity: Pick<TerminalVersionedIdentity, "generation" | "terminalId">,
    ): Promise<TerminalSessionDescriptor>;
    kill(identity: TerminalVersionedIdentity): Promise<TerminalSessionDescriptor>;
    list(): Promise<TerminalSessionDescriptor[]>;
    open(input: TerminalOpenInput): Promise<TerminalOpenResult>;
}

export function createTerminalTransport(
    endpoint: Endpoint,
    instance: string,
): TerminalTransport {
    const port = createPortClient(endpoint, instance, TERMINAL_PORT);
    return {
        attach: async (input) =>
            new MessageStreamTerminalAttachment(
                await port.open("attach", input),
            ),
        get: (identity) => port.request<TerminalSessionDescriptor>("get", identity),
        kill: (identity) => port.request<TerminalSessionDescriptor>("kill", identity),
        list: () => port.request<TerminalSessionDescriptor[]>("list"),
        open: (input) => port.request<TerminalOpenResult>("open", input),
    };
}

class MessageStreamTerminalAttachment implements TerminalAttachment {
    readonly #stream: MessageStream;
    readonly #queue: TerminalStreamMessage[] = [];
    readonly #waiters: Array<(message: TerminalStreamMessage) => void> = [];
    #error?: Error;
    #finished = false;

    constructor(stream: MessageStream) {
        this.#stream = stream;
        stream.onData((message) =>
            this.#push(
                readTerminalStreamMessage(message as EventStreamEnvelope),
            ),
        );
        stream.onClose((message) => this.#finish(undefined, message));
        stream.onCancel((error) => {
            this.#error =
                error === undefined
                    ? undefined
                    : Object.assign(new Error(error.message), {
                          ...(error.code === undefined
                              ? {}
                              : { code: error.code }),
                          ...(error.details === undefined
                              ? {}
                              : { details: error.details }),
                          ...(error.retryable === undefined
                              ? {}
                              : { retryable: error.retryable }),
                      });
            this.#finish();
        });
    }

    async next(): Promise<TerminalStreamMessage> {
        const message = this.#queue.shift();
        if (message !== undefined) return message;
        if (this.#finished) return this.#closedMessage();
        return await new Promise((resolve) => this.#waiters.push(resolve));
    }

    ack(
        identity: TerminalVersionedIdentity,
        throughSeq: number,
    ): Promise<void> {
        return this.#stream.send({
            name: "ack",
            payload: {
                generation: identity.generation,
                terminalId: identity.terminalId,
                throughSeq,
                version: identity.version,
            },
        });
    }

    sendInput(
        data: string,
        command: TerminalStreamCommandIdentity,
    ): Promise<void> {
        return this.#stream.send({
            name: "input",
            payload: { ...command, data },
        });
    }

    sendResize(
        cols: number,
        rows: number,
        command: TerminalStreamCommandIdentity,
    ): Promise<void> {
        return this.#stream.send({
            name: "resize",
            payload: { ...command, cols, rows },
        });
    }

    close(): void {
        if (!this.#finished) void this.#stream.close();
        this.#finish();
    }

    #push(message: TerminalStreamMessage | undefined): void {
        if (message === undefined) return;
        const waiter = this.#waiters.shift();
        if (waiter !== undefined) waiter(message);
        else this.#queue.push(message);
    }

    #finish(error?: Error, message?: unknown): void {
        this.#session = readSessionMessage(message);
        this.#finished = true;
        if (error !== undefined) this.#error = error;
        const closed = this.#closedMessage();
        for (const waiter of this.#waiters.splice(0)) waiter(closed);
    }

    #closedMessage(): TerminalStreamMessage {
        return {
            ...(this.#error === undefined ? {} : { error: this.#error }),
            ...(this.#session === undefined ? {} : { session: this.#session }),
            kind: "closed",
        };
    }

    #session?: TerminalSessionDescriptor;
}

function readSessionMessage(
    value: unknown,
): TerminalSessionDescriptor | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    try {
        return readTerminalSession(value);
    } catch {
        return undefined;
    }
}

function readTerminalStreamMessage(
    envelope: EventStreamEnvelope,
): TerminalStreamMessage | undefined {
    const payload: Record<string, JsonValue> = record(envelope.payload) ?? {};
    if (envelope.name === "seed") {
        const session = payload.session;
        return session === undefined
            ? undefined
            : { kind: "seed", session: readTerminalSession(session) };
    }
    if (envelope.name === "output") {
        return {
            frame: readTerminalOutput(envelope.payload),
            kind: "output",
        };
    }
    if (envelope.name === "inputAccepted" || envelope.name === "resized") {
        return {
            clientSeq: readInteger(payload, "clientSeq"),
            identity: readTerminalIdentity(payload),
            kind: envelope.name,
        };
    }
    if (envelope.name === "exit") {
        return { event: readTerminalExit(envelope.payload), kind: "exit" };
    }
    return undefined;
}

function readTerminalSession(value: unknown): TerminalSessionDescriptor {
    const payload = readRecord(value);
    return {
        cols: readInteger(payload, "cols"),
        createdAt: readString(payload, "createdAt"),
        generation: readInteger(payload, "generation"),
        instance: readString(payload, "instance"),
        latestSeq: readInteger(payload, "latestSeq"),
        rows: readInteger(payload, "rows"),
        state: readState(payload.state),
        terminalId: readString(payload, "terminalId"),
        version: readInteger(payload, "version"),
    };
}

function readTerminalOutput(value: JsonValue | undefined): TerminalOutputFrame {
    const payload = readRecord(value);
    return {
        data: readString(payload, "data"),
        seq: readInteger(payload, "seq"),
    };
}

function readTerminalExit(value: JsonValue | undefined): TerminalExitEvent {
    const payload = readRecord(value);
    const signal = payload.signal;
    return {
        exitCode: readInteger(payload, "exitCode"),
        ...(typeof signal === "number" ? { signal } : {}),
    };
}

function readTerminalIdentity(
    value: Record<string, unknown>,
): TerminalVersionedIdentity {
    return {
        generation: readInteger(value, "generation"),
        terminalId: readString(value, "terminalId"),
        version: readInteger(value, "version"),
    };
}

function readRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("Terminal payload must be an object.");
    return value as Record<string, unknown>;
}

function readString(value: Record<string, unknown>, field: string): string {
    if (typeof value[field] !== "string")
        throw new Error(`Terminal ${field} must be a string.`);
    return value[field];
}

function readInteger(value: Record<string, unknown>, field: string): number {
    if (typeof value[field] !== "number" || !Number.isSafeInteger(value[field]))
        throw new Error(`Terminal ${field} must be a safe integer.`);
    return value[field];
}

function readState(value: unknown): TerminalSessionState {
    if (
        value !== "running" &&
        value !== "exited" &&
        value !== "killed" &&
        value !== "lost" &&
        value !== "failed"
    ) {
        throw new Error("Terminal state is invalid.");
    }
    return value;
}

function record(
    value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
