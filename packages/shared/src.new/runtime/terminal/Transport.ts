// Thin typed terminal transport. RPC operations cover session discovery and
// lifecycle; attach opens the bidirectional stream and exposes it as a typed
// TerminalAttachment (seed/output/ack plus input and resize).

import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { Rpc } from "../../transport/packet/Rpc.js";
import { Stream, type MessageStream } from "../../transport/packet/Stream.js";
import type { JsonValue } from "../../transport/primitive/JsonValue.js";
import type { InstanceStreamEnvelope } from "../activity/Contract.js";
import {
    readTerminalSession,
    readTerminalStreamMessage,
    terminalOperations,
    type TerminalOperation,
    type TerminalRequest,
    type TerminalResponse,
} from "./Contract.js";
import type {
    TerminalAttachInput,
    TerminalOpenInput,
    TerminalSessionDescriptor,
    TerminalStreamCommandIdentity,
    TerminalStreamMessage,
    TerminalVersionedIdentity,
} from "./Model.js";

export const TERMINAL_PORT = "terminal";

export interface TerminalAttachment {
    ack(identity: TerminalVersionedIdentity, throughSeq: number): Promise<void>;
    close(): void;
    next(): Promise<TerminalStreamMessage>;
    sendInput(data: string, command: TerminalStreamCommandIdentity): Promise<void>;
    sendResize(
        cols: number,
        rows: number,
        command: TerminalStreamCommandIdentity,
    ): Promise<void>;
}

export interface TerminalTransport {
    attach(instance: string, input: TerminalAttachInput): Promise<TerminalAttachment>;
    get(
        instance: string,
        identity: Pick<TerminalVersionedIdentity, "generation" | "terminalId">,
    ): Promise<TerminalSessionDescriptor>;
    kill(
        instance: string,
        identity: TerminalVersionedIdentity,
    ): Promise<TerminalSessionDescriptor>;
    list(instance: string): Promise<TerminalSessionDescriptor[]>;
    open(instance: string, input: TerminalOpenInput): Promise<TerminalResponse<"open">>;
}

export function createTerminalTransport(endpoint: Endpoint): TerminalTransport {
    const request = async <Operation extends TerminalOperation>(
        instance: string,
        operation: Operation,
        payload: TerminalRequest<Operation>,
    ): Promise<TerminalResponse<Operation>> => {
        const rpc = new Rpc(await endpoint.connect(instance, TERMINAL_PORT));
        try {
            return await rpc.request<TerminalResponse<Operation>>(
                operation,
                payload,
            );
        } finally {
            rpc.close();
        }
    };
    return {
        attach: async (instance, input) => {
            const protocol = new Stream(
                await endpoint.connect(instance, TERMINAL_PORT),
            );
            const stream = await protocol.open(
                terminalOperations.attach,
                input as unknown as JsonValue,
            );
            const close = () => protocol.close();
            stream.onClose(close);
            stream.onCancel(close);
            return new MessageStreamTerminalAttachment(stream);
        },
        get: (instance, identity) =>
            request(instance, terminalOperations.get, identity),
        kill: (instance, identity) =>
            request(instance, terminalOperations.kill, identity),
        list: (instance) => request(instance, terminalOperations.list, undefined),
        open: (instance, input) => request(instance, terminalOperations.open, input),
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
            this.#push(readTerminalStreamMessage(message as InstanceStreamEnvelope)),
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

    ack(identity: TerminalVersionedIdentity, throughSeq: number): Promise<void> {
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
            ...(this.#session === undefined
                ? {}
                : { session: this.#session }),
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
