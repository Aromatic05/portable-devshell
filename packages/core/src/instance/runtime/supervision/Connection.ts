import type { InstanceEventInput, WorkerHandshakeResult } from "../../Api.js";
import {
    Endpoint,
    createRemoteError,
    runtimeErrorCodes,
    type JsonValue,
    type ReverseEnrollmentState,
    type ReverseInstanceStatus,
    type ReverseTransport,
} from "@portable-devshell/shared";

import type { InstanceStateUpdate } from "./State.js";
import type { InstanceSnapshot } from "./State.js";
import type { WorkerProtocolClient } from "../../transport/packet/Client.js";
import type { Channel } from "@portable-devshell/shared";
import type {
    TransportConnection,
    ReverseAttachment,
} from "../../transport/endpoint/Connection.js";
import type { ResolvedWorkerInstanceConfig } from "../provision/Config.js";
import {
    getErrorCode,
    isKnownErrorCode,
    readErrorMessage,
    wrapWorkerCommandError,
} from "../execution/Error.js";
import { toEventData } from "./Event.js";

const reconnectRetryDelayMs = 250;

interface WorkerInstanceConnectionOptions {
    appendEvent(
        type: InstanceEventInput["type"],
        data?: JsonValue,
    ): Promise<unknown>;
    applyStateUpdate(update: InstanceStateUpdate): Promise<InstanceSnapshot>;
    config: ResolvedWorkerInstanceConfig;
    protocolClient: WorkerProtocolClient;
    endpoint: Endpoint;
    snapshot(): InstanceSnapshot;
    transportConnection: TransportConnection;
}

export class WorkerInstanceConnection {
    readonly #appendEvent: WorkerInstanceConnectionOptions["appendEvent"];
    readonly #applyStateUpdate: WorkerInstanceConnectionOptions["applyStateUpdate"];
    readonly #config: ResolvedWorkerInstanceConfig;
    readonly #protocolClient: WorkerProtocolClient;
    readonly #endpoint: Endpoint;
    readonly #snapshot: WorkerInstanceConnectionOptions["snapshot"];
    readonly #transportConnection: TransportConnection;
    readonly #unsubscribeAttach: () => void;
    #closed = false;
    #handshake?: WorkerHandshakeResult;
    #intentionalTransportCloseDepth = 0;
    #reconnectPromise?: Promise<InstanceSnapshot>;
    #reverseStatus?: ReverseInstanceStatus;

    constructor(options: WorkerInstanceConnectionOptions) {
        this.#appendEvent = options.appendEvent;
        this.#applyStateUpdate = options.applyStateUpdate;
        this.#config = options.config;
        this.#protocolClient = options.protocolClient;
        this.#endpoint = options.endpoint;
        this.#snapshot = options.snapshot;
        this.#transportConnection = options.transportConnection;
        this.#unsubscribeAttach = this.#transportConnection.onAttach((input) =>
            this.#acceptAttachedReverseChannel(input),
        );
        if (this.#config.managementMode === "selfManaged") {
            this.#reverseStatus = {
                availability: "offline",
                enrollmentState: "pending",
                managementMode: "selfManaged",
            };
        }
        this.#endpoint.onTransportClose((error) => {
            void this.#handleTransportDisconnect(
                error ?? new Error("Worker transport closed."),
            ).catch(() => undefined);
        });
    }

    get connected(): boolean {
        return this.#endpoint.connected;
    }

    get handshake(): WorkerHandshakeResult | undefined {
        return this.#handshake;
    }

    snapshotReverse(): ReverseInstanceStatus | undefined {
        return this.#reverseStatus === undefined
            ? undefined
            : { ...this.#reverseStatus };
    }

    clearHandshake(): void {
        this.#handshake = undefined;
    }

    async connectStarted(): Promise<InstanceSnapshot> {
        try {
            await this.#endpoint.reconnect();
            await this.#protocolClient.ping();
            this.#handshake = await this.#protocolClient.handshake(
                this.#config.handshake,
            );
            await this.#appendEvent("worker.transportConnected");
            await this.#appendEvent("instance.started", {
                workerVersion: this.#handshake.workerVersion,
            });
            await this.#applyStateUpdate({
                daemonState: "running",
                lastErrorCode: undefined,
                lastErrorMessage: undefined,
            });
            return await this.#applyStateUpdate({
                connectionState: "connected",
            });
        } catch (error) {
            const wrappedError = wrapWorkerCommandError(
                error,
                runtimeErrorCodes.workerHandshakeFailed,
                `Worker handshake failed for instance ${this.#config.name}.`,
                this.#config.name,
            );
            this.closeTransport();
            this.#handshake = undefined;
            await this.#applyStateUpdate({
                connectionState: "disconnected",
                daemonState: "running",
                lastErrorCode: getErrorCode(
                    wrappedError,
                    runtimeErrorCodes.workerHandshakeFailed,
                ),
                lastErrorMessage: readErrorMessage(wrappedError),
            });
            if (wrappedError !== error) throw wrappedError;
            if (isKnownErrorCode(error)) throw error;
            throw createRemoteError({
                code: runtimeErrorCodes.workerHandshakeFailed,
                cause: error,
                message: `Worker handshake failed for instance ${this.#config.name}.`,
                retryable: false,
                details: { instance: this.#config.name },
            });
        }
    }

    async close(): Promise<void> {
        this.#closed = true;
        this.#unsubscribeAttach();
        this.closeTransport();
        this.#handshake = undefined;
        if (this.#config.managementMode === "selfManaged") {
            this.markReverseOffline();
        }
        await this.#applyStateUpdate({
            connectionState: "disconnected",
            lastErrorCode: undefined,
            lastErrorMessage: undefined,
        });
    }

    async setReverseEnrollmentState(
        enrollmentState: ReverseEnrollmentState,
    ): Promise<InstanceSnapshot> {
        this.#requireSelfManaged();
        this.#reverseStatus = {
            ...(this.#reverseStatus ?? {
                availability: "offline",
                managementMode: "selfManaged",
            }),
            enrollmentState,
        };
        await this.#appendEvent(
            "reverse.enrollmentChanged",
            toEventData({ enrollmentState }),
        );
        return this.#snapshot();
    }

    async acceptReverseChannel(
        channel: Channel,
        input: {
            connectedAt?: string;
            generation: number;
            transport: ReverseTransport;
        },
    ): Promise<InstanceSnapshot> {
        await this.#transportConnection.attach(channel, input);
        return this.#snapshot();
    }

    async #acceptAttachedReverseChannel(
        input: ReverseAttachment,
    ): Promise<InstanceSnapshot> {
        this.#requireSelfManaged();
        const previousGeneration = this.#reverseStatus?.generation ?? 0;
        if (
            !Number.isInteger(input.generation) ||
            input.generation <= previousGeneration
        ) {
            this.#transportConnection.close();
            throw createRemoteError({
                code: runtimeErrorCodes.reverseGenerationInvalid,
                details: {
                    generation: input.generation,
                    instance: this.#config.name,
                    previousGeneration,
                },
                message: `Reverse connection generation must be greater than ${previousGeneration}.`,
                retryable: true,
            });
        }

        const connectedAt = input.connectedAt ?? new Date().toISOString();
        await this.#endpoint.reconnect();
        this.#reverseStatus = {
            availability: "online",
            connectedAt,
            enrollmentState: "enrolled",
            generation: input.generation,
            lastSeenAt: connectedAt,
            managementMode: "selfManaged",
            transport: input.transport,
        };
        await this.#appendEvent(
            "reverse.connected",
            toEventData({
                generation: input.generation,
                transport: input.transport,
            }),
        );
        await this.#appendEvent(
            "reverse.transportChanged",
            toEventData({
                generation: input.generation,
                transport: input.transport,
            }),
        );
        return await this.refreshRunningStatus(undefined, "connecting");
    }

    async reconnectTransport(): Promise<InstanceSnapshot> {
        if (
            this.#config.managementMode === "selfManaged" &&
            !this.#endpoint.connected
        ) {
            throw createRemoteError({
                code: runtimeErrorCodes.reverseTransportUnavailable,
                details: { instance: this.#config.name },
                message: `Reverse instance ${this.#config.name} is offline.`,
                retryable: true,
            });
        }
        if (this.#reconnectPromise !== undefined) {
            return await this.#reconnectPromise;
        }

        this.#reconnectPromise = this.refreshRunningStatus(
            this.#snapshot().pid,
            "reconnecting",
        ).finally(() => {
            this.#reconnectPromise = undefined;
        });
        return await this.#reconnectPromise;
    }

    async refreshRunningStatus(
        pid?: number,
        connectionState:
            "connecting" | "reconnecting" | "connected" = this.#snapshot()
            .connectionState === "connected"
            ? "connected"
            : this.#snapshot().connectionState === "disconnected"
              ? "connecting"
              : "reconnecting",
    ): Promise<InstanceSnapshot> {
        const shouldEmitTransportLifecycleEvents =
            connectionState !== "connected";

        await this.#applyStateUpdate({
            connectionState,
            daemonState: "running",
            lastErrorCode: undefined,
            lastErrorMessage: undefined,
            pid,
        });

        try {
            if (!this.#endpoint.connected) await this.#endpoint.reconnect();
            await this.#protocolClient.ping();
            this.#handshake = await this.#protocolClient.handshake(
                this.#config.handshake,
            );
            if (this.#reverseStatus !== undefined) {
                this.#reverseStatus = {
                    ...this.#reverseStatus,
                    availability: "online",
                    lastErrorCode: undefined,
                    lastErrorMessage: undefined,
                    lastSeenAt: new Date().toISOString(),
                };
            }

            if (shouldEmitTransportLifecycleEvents) {
                await this.#appendEvent("worker.transportConnected");
            }

            return await this.#applyStateUpdate({
                connectionState: "connected",
                daemonState: "running",
                lastErrorCode: undefined,
                lastErrorMessage: undefined,
                pid,
            });
        } catch (error) {
            const wrappedError = wrapWorkerCommandError(
                error,
                runtimeErrorCodes.workerHandshakeFailed,
                `Worker handshake failed for instance ${this.#config.name}.`,
                this.#config.name,
            );
            this.closeTransport();
            this.#handshake = undefined;
            if (this.#config.managementMode === "selfManaged") {
                this.markReverseOffline(wrappedError);
            }
            await this.#applyStateUpdate({
                connectionState: "failed",
                daemonState: "running",
                lastErrorCode: getErrorCode(
                    wrappedError,
                    runtimeErrorCodes.workerHandshakeFailed,
                ),
                lastErrorMessage: readErrorMessage(wrappedError),
                pid,
            });

            if (wrappedError !== error) {
                throw wrappedError;
            }

            if (isKnownErrorCode(error)) {
                throw error;
            }

            throw createRemoteError({
                code: runtimeErrorCodes.workerHandshakeFailed,
                cause: error,
                message: `Worker handshake failed for instance ${this.#config.name}.`,
                retryable: false,
                details: { instance: this.#config.name },
            });
        }
    }

    async stopSelfManaged(): Promise<InstanceSnapshot> {
        this.#requireSelfManaged();
        if (!this.#endpoint.connected) {
            throw createRemoteError({
                code: runtimeErrorCodes.reverseSelfManagedOffline,
                details: { instance: this.#config.name },
                message: `Reverse instance ${this.#config.name} is offline.`,
                retryable: true,
            });
        }

        await this.#applyStateUpdate({
            connectionState: "connected",
            daemonState: "stopping",
            lastErrorCode: undefined,
            lastErrorMessage: undefined,
        });

        try {
            await this.#protocolClient.stop();
        } catch (error) {
            await this.#applyStateUpdate({
                connectionState: "failed",
                daemonState: "failed",
                lastErrorCode: getErrorCode(
                    error,
                    runtimeErrorCodes.workerStopFailed,
                ),
                lastErrorMessage: readErrorMessage(error),
            });
            throw error;
        } finally {
            this.closeTransport();
            this.#handshake = undefined;
            this.markReverseOffline();
        }

        await this.#appendEvent("instance.stopped");
        return await this.#applyStateUpdate({
            connectionState: "disconnected",
            daemonState: "stopped",
            lastErrorCode: undefined,
            lastErrorMessage: undefined,
            pid: undefined,
        });
    }

    markReverseOffline(error?: unknown): void {
        const current = this.#reverseStatus;
        this.#reverseStatus = {
            availability: "offline",
            enrollmentState: current?.enrollmentState ?? "pending",
            ...(current?.generation === undefined
                ? {}
                : { generation: current.generation }),
            ...(error === undefined
                ? {}
                : {
                      lastErrorCode: getErrorCode(
                          error,
                          runtimeErrorCodes.workerTransportDisconnected,
                      ),
                      lastErrorMessage: readErrorMessage(error),
                  }),
            lastSeenAt: new Date().toISOString(),
            managementMode: "selfManaged",
        };
    }

    #requireSelfManaged(): void {
        if (this.#config.managementMode === "selfManaged") {
            return;
        }

        throw createRemoteError({
            code: runtimeErrorCodes.reverseInstanceNotReverse,
            details: { instance: this.#config.name },
            message: `Instance ${this.#config.name} is not a reverse instance.`,
            retryable: false,
        });
    }

    async #handleTransportDisconnect(error: unknown): Promise<void> {
        if (this.#intentionalTransportCloseDepth > 0) {
            return;
        }
        if (this.#config.managementMode === "selfManaged") {
            this.markReverseOffline(error);
            this.#handshake = undefined;
            await this.#appendEvent(
                "worker.transportDisconnected",
                toEventData({
                    errorCode: getErrorCode(
                        error,
                        runtimeErrorCodes.workerTransportDisconnected,
                    ),
                }),
            );
            await this.#appendEvent(
                "reverse.disconnected",
                toEventData({
                    errorCode: getErrorCode(
                        error,
                        runtimeErrorCodes.workerTransportDisconnected,
                    ),
                }),
            );
            await this.#applyStateUpdate({
                connectionState: "disconnected",
                // A disconnected transport does not tell us whether the
                // self-managed remote daemon is alive or stopped.
                daemonState: "unknown",
                lastErrorCode: getErrorCode(
                    error,
                    runtimeErrorCodes.workerTransportDisconnected,
                ),
                lastErrorMessage: readErrorMessage(error),
                pid: undefined,
            });
            return;
        }

        const daemonState = this.#snapshot().daemonState;
        await this.#appendEvent(
            "worker.transportDisconnected",
            toEventData({
                errorCode: getErrorCode(
                    error,
                    runtimeErrorCodes.workerTransportDisconnected,
                ),
            }),
        );

        this.#handshake = undefined;
        await this.#applyStateUpdate({
            connectionState:
                daemonState === "running" ? "reconnecting" : "disconnected",
            daemonState,
            lastErrorCode: getErrorCode(
                error,
                runtimeErrorCodes.workerTransportDisconnected,
            ),
            lastErrorMessage: readErrorMessage(error),
        });

        if (daemonState !== "running") {
            return;
        }

        while (!this.#closed && this.#snapshot().daemonState === "running") {
            try {
                await this.reconnectTransport();
                return;
            } catch {
                if (this.#closed || this.#snapshot().daemonState !== "running")
                    return;
                await delay(reconnectRetryDelayMs);
            }
        }
    }

    closeTransport(): void {
        this.#intentionalTransportCloseDepth += 1;

        try {
            this.#endpoint.disconnect();
            this.#transportConnection.close();
        } finally {
            this.#intentionalTransportCloseDepth -= 1;
        }
    }
}
async function delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
