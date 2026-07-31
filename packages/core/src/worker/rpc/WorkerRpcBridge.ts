import { randomUUID } from "node:crypto";

import type { JsonValue } from "@portable-devshell/shared";

import { readWorkerAbortReason } from "../WorkerAbortReason.js";
import type { WorkerCommandTransport } from "../command/WorkerCommandTransport.js";
import type { WorkerRpcOptions } from "../command/WorkerCommandOptions.js";
import type { WorkerRpcChannel, WorkerRpcConnector } from "./WorkerRpcChannel.js";
import { WorkerRpcError } from "./WorkerRpcError.js";
import type {
    WorkerRpcRequestEnvelope,
    WorkerRpcResponseEnvelope
} from "./WorkerRpcEnvelope.js";
import { WorkerRpcProcessConnector } from "./WorkerRpcProcessChannel.js";

interface PendingResponse {
    cleanup(): void;
    reject: (error: unknown) => void;
    request: WorkerRpcRequestEnvelope;
    resolve: (response: WorkerRpcResponseEnvelope) => void;
}

interface ConnectingHandoff {
    reject(error: Error): void;
    resolve(channel: WorkerRpcChannel): void;
}

type WorkerRpcResponseFrame = Record<string, JsonValue> & WorkerRpcResponseEnvelope;

export interface WorkerRpcBridgeOptions {
    connector?: WorkerRpcConnector;
    preservePendingOnDisconnect?: boolean;
    rpcOptions: WorkerRpcOptions;
    transport?: WorkerCommandTransport;
}

export class WorkerRpcBridge {
    readonly #connector: WorkerRpcConnector;
    readonly #rpcOptions: WorkerRpcOptions;
    readonly #preservePendingOnDisconnect: boolean;
    readonly #disconnectListeners = new Set<(error: WorkerRpcError) => void>();
    readonly #pending = new Map<string, PendingResponse>();
    #channel?: WorkerRpcChannel;
    #connectionGeneration = 0;
    #connectingHandoff?: ConnectingHandoff;
    #connectPromise?: Promise<WorkerRpcChannel>;

    constructor(options: WorkerRpcBridgeOptions) {
        if (options.connector === undefined && options.transport === undefined) {
            throw new TypeError("WorkerRpcBridge requires connector or transport.");
        }
        if (options.connector !== undefined && options.transport !== undefined) {
            throw new TypeError("WorkerRpcBridge accepts connector or transport, not both.");
        }

        this.#rpcOptions = options.rpcOptions;
        this.#preservePendingOnDisconnect = options.preservePendingOnDisconnect === true;
        this.#connector =
            options.connector ?? new WorkerRpcProcessConnector(options.transport!, options.rpcOptions);
    }

    get connected(): boolean {
        return this.#channel !== undefined;
    }

    async connect(): Promise<void> {
        await this.#ensureChannel();
    }

    onDisconnect(listener: (error: WorkerRpcError) => void): () => void {
        this.#disconnectListeners.add(listener);
        return () => {
            this.#disconnectListeners.delete(listener);
        };
    }

    async request(request: WorkerRpcRequestEnvelope, signal?: AbortSignal): Promise<WorkerRpcResponseEnvelope> {
        this.#throwIfCancelled(request, signal);
        const channel = await this.#ensureChannel();
        this.#throwIfCancelled(request, signal);
        if (this.#pending.has(request.id)) {
            throw new Error(`Duplicate Worker RPC request id: ${request.id}`);
        }

        return await new Promise<WorkerRpcResponseEnvelope>((resolve, reject) => {
            let removeAbortListener: () => void = () => {};
            const pending: PendingResponse = {
                cleanup: () => removeAbortListener(),
                reject,
                request,
                resolve
            };
            const onAbort = () => {
                if (this.#pending.get(request.id) !== pending) {
                    return;
                }
                this.#pending.delete(request.id);
                pending.cleanup();
                reject(WorkerRpcError.cancelled(this.#cancellationDetails(request, signal?.reason), signal?.reason));
                this.#enqueueCancellation(request, signal?.reason);
            };
            if (signal !== undefined) {
                signal.addEventListener("abort", onAbort, { once: true });
                removeAbortListener = () => signal.removeEventListener("abort", onAbort);
            }
            this.#pending.set(request.id, pending);
            if (signal?.aborted === true) {
                onAbort();
            }
            if (this.#pending.get(request.id) !== pending) {
                return;
            }
            void channel.send(request as unknown as JsonValue).catch((error: unknown) => {
                this.#disconnectChannel(channel, this.#createDisconnectError(error));
            });
        });
    }

    async replaceChannel(channel: WorkerRpcChannel): Promise<void> {
        this.#connectionGeneration += 1;
        const handoff = this.#takeConnectingHandoff();
        this.#connectPromise = undefined;
        const previous = this.#channel;
        this.#attachChannel(channel);
        if (previous !== undefined && previous !== channel) {
            this.#closeChannel(previous);
        }
        try {
            await this.#replayPending(channel);
        } catch (error) {
            this.#disconnectChannel(channel, this.#createDisconnectError(error));
            handoff?.reject(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
        handoff?.resolve(channel);
    }

    close(_signal: NodeJS.Signals | number = "SIGTERM"): void {
        this.#connectionGeneration += 1;
        const error = WorkerRpcError.disconnected({
            instanceName: this.#rpcOptions.instanceName,
            reason: "bridge_closed"
        });
        this.#takeConnectingHandoff()?.reject(error);
        const channel = this.#channel;
        this.#channel = undefined;
        this.#connectPromise = undefined;
        if (channel !== undefined) {
            this.#closeChannel(channel);
        }
        this.#rejectPending(error);
    }

    async #ensureChannel(): Promise<WorkerRpcChannel> {
        if (this.#channel !== undefined) {
            return this.#channel;
        }
        if (this.#connectPromise === undefined) {
            const generation = this.#connectionGeneration;
            let rejectHandoff!: (error: Error) => void;
            let resolveHandoff!: (channel: WorkerRpcChannel) => void;
            const handoff = new Promise<WorkerRpcChannel>((resolve, reject) => {
                resolveHandoff = resolve;
                rejectHandoff = reject;
            });
            const connectingHandoff: ConnectingHandoff = {
                reject: rejectHandoff,
                resolve: resolveHandoff
            };
            this.#connectingHandoff = connectingHandoff;
            const connection = this.#connector
                .connect()
                .then(async (channel) => {
                    if (generation !== this.#connectionGeneration) {
                        this.#closeChannel(channel);
                        throw new Error("Worker RPC connection was reset while connecting.");
                    }
                    this.#attachChannel(channel);
                    try {
                        await this.#replayPending(channel);
                    } catch (error) {
                        this.#disconnectChannel(channel, this.#createDisconnectError(error));
                        throw error;
                    }
                    if (generation !== this.#connectionGeneration) {
                        if (this.#channel === channel) {
                            this.#channel = undefined;
                        }
                        this.#closeChannel(channel);
                        throw new Error("Worker RPC connection was reset while connecting.");
                    }
                    return channel;
                });
            const promise = Promise.race([connection, handoff])
                .finally(() => {
                    if (this.#connectPromise === promise) {
                        this.#connectPromise = undefined;
                    }
                    if (this.#connectingHandoff === connectingHandoff) {
                        this.#connectingHandoff = undefined;
                    }
                });
            this.#connectPromise = promise;
        }
        return await this.#connectPromise;
    }

    #attachChannel(channel: WorkerRpcChannel): void {
        this.#channel = channel;
        channel.onMessage((message) => {
            if (this.#channel !== channel) {
                return;
            }
            this.#handleMessage(message);
        });
        channel.onDisconnect((cause) => {
            this.#disconnectChannel(channel, this.#createDisconnectError(cause));
        });
    }

    #handleMessage(message: JsonValue): void {
        if (!isWorkerRpcResponseEnvelope(message)) {
            return;
        }
        const pending = this.#pending.get(message.id);
        if (pending === undefined) {
            return;
        }
        this.#pending.delete(message.id);
        pending.cleanup();
        pending.resolve(message);
    }

    #disconnectChannel(channel: WorkerRpcChannel, error: WorkerRpcError): void {
        if (this.#channel !== channel) {
            return;
        }
        this.#channel = undefined;
        this.#closeChannel(channel);
        if (!this.#preservePendingOnDisconnect) {
            this.#rejectPending(error);
        }
        for (const listener of [...this.#disconnectListeners]) {
            try {
                listener(error);
            } catch (listenerError) {
                console.warn(
                    listenerError instanceof Error
                        ? listenerError
                        : new Error(String(listenerError))
                );
            }
        }
    }

    async #replayPending(channel: WorkerRpcChannel): Promise<void> {
        if (!this.#preservePendingOnDisconnect || this.#pending.size === 0) {
            return;
        }
        for (const pending of this.#pending.values()) {
            await channel.send(pending.request as unknown as JsonValue);
        }
    }

    #rejectPending(error: WorkerRpcError): void {
        for (const [requestId, pending] of this.#pending) {
            this.#pending.delete(requestId);
            pending.cleanup();
            pending.reject(error);
        }
    }

    #throwIfCancelled(request: WorkerRpcRequestEnvelope, signal: AbortSignal | undefined): void {
        if (signal?.aborted !== true) {
            return;
        }
        throw WorkerRpcError.cancelled(this.#cancellationDetails(request, signal.reason), signal.reason);
    }

    #enqueueCancellation(request: WorkerRpcRequestEnvelope, reason: unknown): void {
        const ctxId = request.context?.ctxId;
        if (ctxId === undefined || request.method === "tool.call.cancel") {
            return;
        }
        const cancellation: WorkerRpcRequestEnvelope = {
            type: "request",
            id: `cancel-${randomUUID()}`,
            method: "tool.call.cancel",
            params: {
                reason: readWorkerAbortReason(reason),
                rpcRequestId: request.id,
                ctxId
            },
            context: {
                ctxId,
                source: request.context?.source
            }
        };
        const pending: PendingResponse = {
            cleanup: () => undefined,
            reject: () => undefined,
            request: cancellation,
            resolve: () => undefined
        };
        this.#pending.set(cancellation.id, pending);
        const channel = this.#channel;
        if (channel === undefined) {
            if (!this.#preservePendingOnDisconnect) {
                this.#pending.delete(cancellation.id);
            }
            return;
        }
        void channel.send(cancellation as unknown as JsonValue).then(
            () => {
                if (this.#pending.get(cancellation.id) === pending) {
                    this.#pending.delete(cancellation.id);
                }
            },
            (error: unknown) => {
                if (!this.#preservePendingOnDisconnect) {
                    this.#pending.delete(cancellation.id);
                }
                this.#disconnectChannel(channel, this.#createDisconnectError(error));
            }
        );
    }

    #cancellationDetails(request: WorkerRpcRequestEnvelope, reason: unknown): JsonValue {
        return {
            instanceName: this.#rpcOptions.instanceName,
            method: request.method,
            reason: readWorkerAbortReason(reason),
            rpcRequestId: request.id,
            ctxId: request.context?.ctxId
        } as JsonValue;
    }

    #createDisconnectError(cause: unknown): WorkerRpcError {
        return WorkerRpcError.disconnected(
            {
                causeCode:
                    typeof cause === "object" &&
                    cause !== null &&
                    "code" in cause &&
                    typeof cause.code === "string"
                        ? cause.code
                        : undefined,
                causeMessage: cause instanceof Error ? cause.message : String(cause),
                instanceName: this.#rpcOptions.instanceName
            } as JsonValue,
            cause
        );
    }

    #closeChannel(channel: WorkerRpcChannel): void {
        try {
            channel.close();
        } catch (error) {
            console.warn(error instanceof Error ? error : new Error(String(error)));
        }
    }

    #takeConnectingHandoff(): ConnectingHandoff | undefined {
        const handoff = this.#connectingHandoff;
        this.#connectingHandoff = undefined;
        return handoff;
    }
}

function isWorkerRpcResponseEnvelope(value: JsonValue): value is WorkerRpcResponseFrame {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    const candidate = value as Record<string, JsonValue>;
    return candidate.type === "response" && typeof candidate.id === "string" && typeof candidate.ok === "boolean";
}
