import type { JsonValue } from "@portable-devshell/shared";

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
    reject: (error: unknown) => void;
    request: WorkerRpcRequestEnvelope;
    resolve: (response: WorkerRpcResponseEnvelope) => void;
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

    async request(request: WorkerRpcRequestEnvelope): Promise<WorkerRpcResponseEnvelope> {
        const channel = await this.#ensureChannel();

        return await new Promise<WorkerRpcResponseEnvelope>((resolve, reject) => {
            const pending: PendingResponse = { reject, request, resolve };
            this.#pending.set(request.id, pending);
            void channel.send(request as unknown as JsonValue).catch((error: unknown) => {
                if (!this.#preservePendingOnDisconnect) {
                    this.#pending.delete(request.id);
                }
                this.#disconnectChannel(channel, this.#createDisconnectError(error));
            });
        });
    }

    async replaceChannel(channel: WorkerRpcChannel): Promise<void> {

        const previous = this.#channel;
        this.#attachChannel(channel);
        if (previous !== undefined && previous !== channel) {
            previous.close();
        }
        await this.#replayPending(channel);
    }

    close(_signal: NodeJS.Signals | number = "SIGTERM"): void {
        const error = WorkerRpcError.disconnected({
            instanceName: this.#rpcOptions.instanceName,
            reason: "bridge_closed"
        });
        const channel = this.#channel;
        this.#channel = undefined;
        channel?.close();
        this.#rejectPending(error);
    }

    async #ensureChannel(): Promise<WorkerRpcChannel> {
        if (this.#channel !== undefined) {
            return this.#channel;
        }
        if (this.#connectPromise === undefined) {
            this.#connectPromise = this.#connector
                .connect()
                .then(async (channel) => {
                    this.#attachChannel(channel);
                    await this.#replayPending(channel);
                    return channel;
                })
                .finally(() => {
                    this.#connectPromise = undefined;
                });
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
        pending.resolve(message);
    }

    #disconnectChannel(channel: WorkerRpcChannel, error: WorkerRpcError): void {
        if (this.#channel !== channel) {
            return;
        }
        this.#channel = undefined;
        if (!this.#preservePendingOnDisconnect) {
            this.#rejectPending(error);
        }
        for (const listener of this.#disconnectListeners) {
            listener(error);
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
            pending.reject(error);
        }
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
}

function isWorkerRpcResponseEnvelope(value: JsonValue): value is WorkerRpcResponseFrame {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    const candidate = value as Record<string, JsonValue>;
    return candidate.type === "response" && typeof candidate.id === "string" && typeof candidate.ok === "boolean";
}
