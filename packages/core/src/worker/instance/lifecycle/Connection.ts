import {
    Endpoint,
    createError,
    errorCodes,
    type JsonValue,
    type ReverseEnrollmentState,
    type ReverseInstanceStatus,
    type ReverseTransport,
} from "@portable-devshell/shared";

import type { InstanceEventInput } from "../../../instance/EventBuffer.js";
import type { InstanceStateUpdate } from "../../../instance/state/Machine.js";
import type { InstanceSnapshot } from "../../../instance/state/Snapshot.js";
import type {
    WorkerProtocolClient,
    WorkerHandshakeResult,
} from "../../protocol/Client.js";
import type { Channel } from "@portable-devshell/shared";
import type { WorkerToolCatalog } from "../../tool/Catalog.js";
import type { WorkerTransportConnection } from "../../transport/Transport.js";
import type { ResolvedWorkerInstanceConfig } from "../Config.js";
import {
    getErrorCode,
    isKnownErrorCode,
    readErrorMessage,
    wrapWorkerCommandError,
} from "../state/Error.js";
import { toEventData } from "../state/Event.js";

const reconnectRetryDelayMs = 250;

interface WorkerInstanceConnectionOptions {
    appendEvent(
        type: InstanceEventInput["type"],
        data?: JsonValue,
    ): Promise<unknown>;
    applyStateUpdate(update: InstanceStateUpdate): Promise<InstanceSnapshot>;
    catalog: WorkerToolCatalog;
    config: ResolvedWorkerInstanceConfig;
    protocolClient: WorkerProtocolClient;
    endpoint: Endpoint;
    snapshot(): InstanceSnapshot;
    transportConnection: WorkerTransportConnection;
}

export class WorkerInstanceConnection {
    readonly #appendEvent: WorkerInstanceConnectionOptions["appendEvent"];
    readonly #applyStateUpdate: WorkerInstanceConnectionOptions["applyStateUpdate"];
    readonly #catalog: WorkerToolCatalog;
    readonly #config: ResolvedWorkerInstanceConfig;
    readonly #protocolClient: WorkerProtocolClient;
    readonly #endpoint: Endpoint;
    readonly #snapshot: WorkerInstanceConnectionOptions["snapshot"];
    readonly #transportConnection: WorkerTransportConnection;
    #closed = false;
    #handshake?: WorkerHandshakeResult;
    #intentionalTransportCloseDepth = 0;
    #reconnectPromise?: Promise<InstanceSnapshot>;
    #reverseStatus?: ReverseInstanceStatus;

    constructor(options: WorkerInstanceConnectionOptions) {
        this.#appendEvent = options.appendEvent;
        this.#applyStateUpdate = options.applyStateUpdate;
        this.#catalog = options.catalog;
        this.#config = options.config;
        this.#protocolClient = options.protocolClient;
        this.#endpoint = options.endpoint;
        this.#snapshot = options.snapshot;
        this.#transportConnection = options.transportConnection;
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
            const tools = await this.#protocolClient.listTools();
            const refreshedTools = this.#catalog.refresh(tools.tools);
            await this.#appendEvent("worker.transportConnected");
            await this.#appendEvent(
                "worker.schemaRefreshed",
                toEventData({ toolCount: refreshedTools.length }),
            );
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
                errorCodes.coreWorkerHandshakeFailed,
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
                    errorCodes.coreWorkerHandshakeFailed,
                ),
                lastErrorMessage: readErrorMessage(wrappedError),
            });
            if (wrappedError !== error) throw wrappedError;
            if (isKnownErrorCode(error)) throw error;
            throw createError({
                code: errorCodes.coreWorkerHandshakeFailed,
                cause: error,
                message: `Worker handshake failed for instance ${this.#config.name}.`,
                retryable: false,
                details: { instance: this.#config.name },
            });
        }
    }

    async close(): Promise<void> {
        this.#closed = true;
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
        this.#requireSelfManaged();
        const previousGeneration = this.#reverseStatus?.generation ?? 0;
        if (
            !Number.isInteger(input.generation) ||
            input.generation <= previousGeneration
        ) {
            channel.close();
            throw createError({
                code: errorCodes.reverseGenerationInvalid,
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
        this.#transportConnection.attach(channel);
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
            throw createError({
                code: errorCodes.reverseTransportUnavailable,
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
        const shouldEmitTransportLifecycleEvents = connectionState !== "connected";

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
            const tools = await this.#protocolClient.listTools();
            const refreshedTools = this.#catalog.refresh(tools.tools);
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
                await this.#appendEvent(
                    "worker.schemaRefreshed",
                    toEventData({ toolCount: refreshedTools.length }),
                );
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
                errorCodes.coreWorkerHandshakeFailed,
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
                    errorCodes.coreWorkerHandshakeFailed,
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

            throw createError({
                code: errorCodes.coreWorkerHandshakeFailed,
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
            throw createError({
                code: errorCodes.reverseSelfManagedOffline,
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
                    errorCodes.coreWorkerStopFailed,
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
                          errorCodes.coreWorkerTransportDisconnected,
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

        throw createError({
            code: errorCodes.reverseInstanceNotReverse,
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
                        errorCodes.coreWorkerTransportDisconnected,
                    ),
                }),
            );
            await this.#appendEvent(
                "reverse.disconnected",
                toEventData({
                    errorCode: getErrorCode(
                        error,
                        errorCodes.coreWorkerTransportDisconnected,
                    ),
                }),
            );
            await this.#applyStateUpdate({
                connectionState: "disconnected",
                daemonState: "stopped",
                lastErrorCode: getErrorCode(
                    error,
                    errorCodes.coreWorkerTransportDisconnected,
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
                    errorCodes.coreWorkerTransportDisconnected,
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
                errorCodes.coreWorkerTransportDisconnected,
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
