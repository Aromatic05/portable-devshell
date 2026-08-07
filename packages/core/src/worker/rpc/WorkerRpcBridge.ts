import { randomUUID } from "node:crypto";

import { isControlErrorBody, type Channel, type JsonValue } from "@portable-devshell/shared";

import { readWorkerAbortReason } from "../WorkerAbortReason.js";
import type { WorkerCommandTransport } from "../command/WorkerCommandTransport.js";
import type { WorkerRpcOptions } from "../command/WorkerCommandOptions.js";
import { WorkerRpcError } from "./WorkerRpcError.js";
import type {
    WorkerRpcNotificationEnvelope,
    WorkerRpcRequestEnvelope,
    WorkerRpcResponseEnvelope
} from "./WorkerRpcEnvelope.js";
import { decodeWorkerRpcMessage, encodeWorkerRpcMessage } from "./WorkerRpcEnvelope.js";
import { WorkerRpcProcessConnector } from "./WorkerRpcProcessAdapter.js";

const DEFAULT_CANCELLATION_RETENTION_MS = 30_000;

export interface WorkerRpcConnector {
    attach?(channel: Channel): void;
    connect(signal?: AbortSignal): Promise<Channel>;
    detach?(channel?: Channel): void;
}

interface PendingResponse {
    cleanup(): void;
    reject: (error: unknown) => void;
    request: WorkerRpcRequestEnvelope;
    resolve: (response: WorkerRpcResponseEnvelope) => void;
}

interface ConnectingHandoff {
    reject(error: Error): void;
    resolve(channel: Channel): void;
}

type WorkerRpcResponseFrame = Record<string, JsonValue> & WorkerRpcResponseEnvelope;

export interface WorkerRpcBridgeOptions {
    cancellationRetentionMs?: number;
    connector?: WorkerRpcConnector;
    preservePendingOnDisconnect?: boolean;
    rpcOptions: WorkerRpcOptions;
    transport?: WorkerCommandTransport;
}

export class WorkerRpcBridge {
    readonly #cancellationRetentionMs: number;
    readonly #connector: WorkerRpcConnector;
    readonly #rpcOptions: WorkerRpcOptions;
    readonly #preservePendingOnDisconnect: boolean;
    readonly #connectedListeners = new Set<() => void>();
    readonly #disconnectListeners = new Set<(error: WorkerRpcError) => void>();
    readonly #notificationListeners = new Set<(notification: WorkerRpcNotificationEnvelope) => void>();
    readonly #pending = new Map<string, PendingResponse>();
    #channel?: Channel;
    #connectionGeneration = 0;
    #connectAbortController?: AbortController;
    #connectingHandoff?: ConnectingHandoff;
    #connectPromise?: Promise<Channel>;

    constructor(options: WorkerRpcBridgeOptions) {
        if (options.connector === undefined && options.transport === undefined) {
            throw new TypeError("WorkerRpcBridge requires connector or transport.");
        }
        if (options.connector !== undefined && options.transport !== undefined) {
            throw new TypeError("WorkerRpcBridge accepts connector or transport, not both.");
        }

        this.#cancellationRetentionMs = options.cancellationRetentionMs ?? DEFAULT_CANCELLATION_RETENTION_MS;
        if (!Number.isSafeInteger(this.#cancellationRetentionMs) || this.#cancellationRetentionMs < 1) {
            throw new TypeError("WorkerRpcBridge cancellationRetentionMs must be a positive safe integer.");
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

    onConnected(listener: () => void): () => void {
        this.#connectedListeners.add(listener);
        return () => {
            this.#connectedListeners.delete(listener);
        };
    }

    onDisconnect(listener: (error: WorkerRpcError) => void): () => void {
        this.#disconnectListeners.add(listener);
        return () => {
            this.#disconnectListeners.delete(listener);
        };
    }

    onNotification(
        listener: (notification: WorkerRpcNotificationEnvelope) => void
    ): () => void {
        this.#notificationListeners.add(listener);
        return () => {
            this.#notificationListeners.delete(listener);
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
            void channel.send(encodeWorkerRpcMessage(request as unknown as JsonValue)).catch((error: unknown) => {
                this.#disconnectChannel(channel, this.#createDisconnectError(error));
            });
        });
    }

    async replaceChannel(channel: Channel): Promise<void> {
        this.#connectionGeneration += 1;
        const handoff = this.#takeConnectingHandoff();
        const connectAbortController = this.#takeConnectAbortController();
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
            const normalized = error instanceof Error ? error : new Error(String(error));
            handoff?.reject(normalized);
            connectAbortController?.abort(normalized);
            throw error;
        }
        this.#notifyConnected();
        handoff?.resolve(channel);
        connectAbortController?.abort(new Error("Worker RPC connector was replaced by an attached channel."));
    }

    close(_signal: NodeJS.Signals | number = "SIGTERM"): void {
        this.#connectionGeneration += 1;
        const error = WorkerRpcError.disconnected({
            instanceName: this.#rpcOptions.instanceName,
            reason: "bridge_closed"
        });
        this.#takeConnectingHandoff()?.reject(error);
        this.#takeConnectAbortController()?.abort(error);
        const channel = this.#channel;
        this.#channel = undefined;
        this.#connectPromise = undefined;
        if (channel !== undefined) {
            this.#closeChannel(channel);
        }
        this.#rejectPending(error);
    }

    async #ensureChannel(): Promise<Channel> {
        if (this.#channel !== undefined) {
            return this.#channel;
        }
        if (this.#connectPromise === undefined) {
            const generation = this.#connectionGeneration;
            let rejectHandoff!: (error: Error) => void;
            let resolveHandoff!: (channel: Channel) => void;
            const handoff = new Promise<Channel>((resolve, reject) => {
                resolveHandoff = resolve;
                rejectHandoff = reject;
            });
            const connectingHandoff: ConnectingHandoff = {
                reject: rejectHandoff,
                resolve: resolveHandoff
            };
            const connectAbortController = new AbortController();
            this.#connectAbortController = connectAbortController;
            this.#connectingHandoff = connectingHandoff;
            const connection = this.#connector
                .connect(connectAbortController.signal)
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
                    this.#notifyConnected();
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
                    if (this.#connectAbortController === connectAbortController) {
                        this.#connectAbortController = undefined;
                    }
                });
            this.#connectPromise = promise;
        }
        return await this.#connectPromise;
    }

    #attachChannel(channel: Channel): void {
        this.#channel = channel;
        channel.onFrame((frame) => {
            if (this.#channel !== channel) return;
            try {
                this.#handleMessage(channel, decodeWorkerRpcMessage(frame));
            } catch (error) {
                this.#disconnectChannel(channel, this.#createDisconnectError(error));
            }
        });
        channel.onClose((cause) => {
            this.#disconnectChannel(channel, this.#createDisconnectError(cause ?? new Error("Worker RPC channel closed.")));
        });
    }

    #handleMessage(channel: Channel, message: JsonValue): void {
        if (isWorkerRpcNotificationEnvelope(message)) {
            for (const listener of [...this.#notificationListeners]) {
                try {
                    listener(message);
                } catch (error) {
                    console.warn(error instanceof Error ? error : new Error(String(error)));
                }
            }
            return;
        }
        if (!isWorkerRpcResponseEnvelope(message)) {
            this.#disconnectChannel(
                channel,
                this.#createDisconnectError(
                    new Error("Worker RPC channel returned an invalid message payload.")
                )
            );
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

    #disconnectChannel(channel: Channel, error: WorkerRpcError): void {
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

    async #replayPending(channel: Channel): Promise<void> {
        if (!this.#preservePendingOnDisconnect || this.#pending.size === 0) {
            return;
        }
        for (const pending of this.#pending.values()) {
            await channel.send(encodeWorkerRpcMessage(pending.request as unknown as JsonValue));
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
        let expiryTimer: ReturnType<typeof setTimeout> | undefined;
        const pending: PendingResponse = {
            cleanup: () => {
                if (expiryTimer !== undefined) {
                    clearTimeout(expiryTimer);
                    expiryTimer = undefined;
                }
            },
            reject: () => undefined,
            request: cancellation,
            resolve: () => undefined
        };
        this.#pending.set(cancellation.id, pending);
        expiryTimer = setTimeout(() => {
            if (this.#pending.get(cancellation.id) === pending) {
                this.#pending.delete(cancellation.id);
                pending.cleanup();
            }
        }, this.#cancellationRetentionMs);
        expiryTimer.unref?.();
        const channel = this.#channel;
        if (channel === undefined) {
            if (!this.#preservePendingOnDisconnect) {
                this.#pending.delete(cancellation.id);
                pending.cleanup();
            }
            return;
        }
        void channel.send(encodeWorkerRpcMessage(cancellation as unknown as JsonValue)).catch((error: unknown) => {
            if (!this.#preservePendingOnDisconnect) {
                this.#pending.delete(cancellation.id);
                pending.cleanup();
            }
            this.#disconnectChannel(channel, this.#createDisconnectError(error));
        });
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

    #closeChannel(channel: Channel): void {
        try {
            channel.close();
        } catch (error) {
            console.warn(error instanceof Error ? error : new Error(String(error)));
        }
    }


    #notifyConnected(): void {
        for (const listener of [...this.#connectedListeners]) {
            try {
                listener();
            } catch (error) {
                console.warn(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }

    #takeConnectingHandoff(): ConnectingHandoff | undefined {
        const handoff = this.#connectingHandoff;
        this.#connectingHandoff = undefined;
        return handoff;
    }

    #takeConnectAbortController(): AbortController | undefined {
        const controller = this.#connectAbortController;
        this.#connectAbortController = undefined;
        return controller;
    }
}


function isWorkerRpcNotificationEnvelope(
    value: JsonValue
): value is WorkerRpcNotificationEnvelope {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const candidate = value as Record<string, JsonValue>;
    return candidate.type === "notification" &&
        typeof candidate.method === "string" &&
        candidate.method.length > 0 &&
        Object.prototype.hasOwnProperty.call(candidate, "params");
}

function isWorkerRpcResponseEnvelope(value: JsonValue): value is WorkerRpcResponseFrame {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    const candidate = value as Record<string, JsonValue>;
    if (candidate.type !== "response" || typeof candidate.id !== "string") {
        return false;
    }
    if (candidate.ok === true) {
        return Object.prototype.hasOwnProperty.call(candidate, "result");
    }
    if (candidate.ok === false) {
        return isControlErrorBody(candidate.error);
    }
    return false;
}
