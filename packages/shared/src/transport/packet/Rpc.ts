import { Connection, Port } from "../endpoint/route/Route.js";
import type { Address } from "../envelope/Codec.js";
import type { Message } from "./Packet.js";

export interface RpcError {
    readonly message: string;
    readonly code?: string;
    readonly details?: unknown;
    readonly retryable?: boolean;
}

export interface RpcContext {
    readonly peer: Address;
    readonly requestId: string;
    readonly signal: AbortSignal;
    afterReply(action: () => Promise<void> | void): void;
}

export type RpcHandler = (
    message: Message | undefined,
    context: RpcContext,
) => Message | Promise<Message>;

export type RpcPacket =
    | { protocol: "rpc"; type: "request"; id: string; method: string; message?: Message }
    | { protocol: "rpc"; type: "reply"; id: string; message?: Message }
    | { protocol: "rpc"; type: "error"; id: string; error: RpcError }
    | { protocol: "rpc"; type: "cancel"; id: string };

interface Pending {
    readonly peer: Address;
    resolve(value: Message | undefined): void;
    reject(error: Error): void;
}

export class Rpc {
    readonly #active = new Map<string, AbortController>();
    readonly #handlers = new Map<string, RpcHandler>();
    readonly #pending = new Map<string, Pending>();
    readonly #target: Connection | Port;
    readonly #unsubscribe: () => void;

    constructor(
        target: Connection | Port,
        handlers: Readonly<Record<string, RpcHandler>> = {},
    ) {
        this.#target = target;
        if (target instanceof Connection) {
            const offPacket = target.onPacket((packet) =>
                this.#accept(packet, target.remote),
            );
            const offClose = target.onClose((error) =>
                this.#disconnect(error),
            );
            this.#unsubscribe = () => {
                offPacket();
                offClose();
            };
        } else {
            this.#unsubscribe = target.onPacket((packet, peer) =>
                this.#accept(packet, peer),
            );
        }
        for (const [method, handler] of Object.entries(handlers))
            this.handle(method, handler);
    }

    handle(method: string, handler: RpcHandler): () => void {
        if (this.#handlers.has(method))
            throw new Error(`RPC method ${method} is already handled.`);
        this.#handlers.set(method, handler);
        return () => this.#handlers.delete(method);
    }

    async request<T = Message>(
        method: string,
        message?: Message,
        signal?: AbortSignal,
    ): Promise<T> {
        if (!(this.#target instanceof Connection))
            throw new Error("RPC request requires a Connection.");
        const connection = this.#target;
        signal?.throwIfAborted();
        const id = crypto.randomUUID();
        const response = new Promise<Message | undefined>((resolve, reject) =>
            this.#pending.set(id, { peer: connection.remote, reject, resolve }),
        );
        let rejectCancellation: ((reason?: unknown) => void) | undefined;
        const cancellation =
            signal === undefined
                ? undefined
                : new Promise<never>((_resolve, reject) => {
                      rejectCancellation = reject;
                  });
        const abort = () => {
            const pending = this.#pending.get(id);
            if (pending === undefined) return;
            this.#pending.delete(id);
            const reason = signal!.reason;
            if (!connection.connected) {
                rejectCancellation!(reason);
                return;
            }
            connection
                .send({ protocol: "rpc", type: "cancel", id })
                .then(
                    () => rejectCancellation!(reason),
                    (error) =>
                        rejectCancellation!(
                            connection.connected ? error : reason,
                        ),
                );
        };
        signal?.addEventListener("abort", abort, { once: true });
        try {
            const outcome =
                cancellation === undefined
                    ? response
                    : Promise.race([response, cancellation]);
            const [, value] = await Promise.all([
                connection.send({
                    protocol: "rpc",
                    type: "request",
                    id,
                    method,
                    ...(message === undefined ? {} : { message }),
                } satisfies RpcPacket),
                outcome,
            ]);
            return value as T;
        } finally {
            this.#pending.delete(id);
            signal?.removeEventListener("abort", abort);
        }
    }

    close(): void {
        this.#unsubscribe();
        this.#disconnect(new Error("RPC closed."));
        this.#handlers.clear();
    }

    #disconnect(error?: Error): void {
        const failure = error ?? new Error("RPC connection closed.");
        for (const controller of this.#active.values())
            controller.abort(failure);
        for (const pending of this.#pending.values())
            pending.reject(failure);
        this.#active.clear();
        this.#pending.clear();
    }

    async #accept(value: unknown, peer: Address): Promise<void> {
        const packet = parse(value);
        if (packet === undefined) return;
        if (packet.type === "request") {
            await this.#request(packet, peer);
            return;
        }
        if (packet.type === "cancel") {
            this.#active.get(packet.id)?.abort();
            return;
        }
        const pending = this.#pending.get(packet.id);
        if (
            pending === undefined ||
            pending.peer.host !== peer.host ||
            pending.peer.port !== peer.port
        )
            return;
        this.#pending.delete(packet.id);
        if (packet.type === "error") pending.reject(toError(packet.error));
        else pending.resolve(packet.message);
    }

    async #request(
        packet: Extract<RpcPacket, { type: "request" }>,
        peer: Address,
    ): Promise<void> {
        const connection =
            this.#target instanceof Connection
                ? this.#target
                : this.#target.connect(peer.host, peer.port);
        const handler = this.#handlers.get(packet.method);
        if (handler === undefined) {
            if (connection.connected)
                await connection.send({
                    protocol: "rpc",
                    type: "error",
                    id: packet.id,
                    error: {
                        code: "method_not_found",
                        message:
                            "RPC method " + packet.method + " was not found.",
                    },
                } satisfies RpcPacket);
            return;
        }
        const controller = new AbortController();
        const afterReply: Array<() => Promise<void> | void> = [];
        this.#active.set(packet.id, controller);
        try {
            let message: Message | undefined;
            try {
                message = await handler(packet.message, {
                    afterReply: (action) => afterReply.push(action),
                    peer,
                    requestId: packet.id,
                    signal: controller.signal,
                });
            } catch (error) {
                if (connection.connected)
                    await connection.send({
                        protocol: "rpc",
                        type: "error",
                        id: packet.id,
                        error: fromError(error),
                    } satisfies RpcPacket);
                return;
            }
            if (!connection.connected) return;
            await connection.send({
                protocol: "rpc",
                type: "reply",
                id: packet.id,
                ...(message === undefined ? {} : { message }),
            } satisfies RpcPacket);
            for (const action of afterReply) queueMicrotask(() => void action());
        } finally {
            this.#active.delete(packet.id);
        }
    }
}

function parse(value: unknown): RpcPacket | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const packet = value as Record<string, unknown>;
    if (packet.protocol !== "rpc") return undefined;
    if (typeof packet.id !== "string" || typeof packet.type !== "string")
        throw new Error("Invalid RPC packet.");
    if (packet.type === "request" && typeof packet.method === "string")
        return {
            protocol: "rpc",
            type: "request",
            id: packet.id,
            method: packet.method,
            ...(packet.message === undefined ? {} : { message: packet.message }),
        };
    if (packet.type === "reply")
        return {
            protocol: "rpc",
            type: "reply",
            id: packet.id,
            ...(packet.message === undefined ? {} : { message: packet.message }),
        };
    if (packet.type === "cancel")
        return { protocol: "rpc", type: "cancel", id: packet.id };
    if (
        packet.type === "error" &&
        typeof packet.error === "object" &&
        packet.error !== null &&
        typeof (packet.error as RpcError).message === "string"
    )
        return {
            protocol: "rpc",
            type: "error",
            id: packet.id,
            error: packet.error as unknown as RpcError,
        };
    throw new Error("Invalid RPC packet.");
}

function fromError(error: unknown): RpcError {
    if (!(error instanceof Error)) return { message: String(error) };
    const value = error as Error & {
        code?: string;
        details?: unknown;
        retryable?: boolean;
    };
    return {
        message: error.message,
        ...(value.code === undefined ? {} : { code: value.code }),
        ...(value.details === undefined ? {} : { details: value.details }),
        ...(value.retryable === undefined ? {} : { retryable: value.retryable }),
    };
}

function toError(error: RpcError): Error {
    return Object.assign(new Error(error.message), {
        ...(error.code === undefined ? {} : { code: error.code }),
        ...(error.details === undefined ? {} : { details: error.details }),
        ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
    });
}
