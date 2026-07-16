import {
    asWorkspacePath,
    createError,
    errorCodes,
    type JsonValue,
    type ReverseEnrollmentState,
    type ReverseInstanceStatus,
    type ReverseTransport,
    type WorkspacePath
} from "@portable-devshell/shared";

import type { InstanceEventInput } from "../../log/LogEventBuffer.js";
import type { InstanceStateUpdate } from "../../instance/state/InstanceStateMachine.js";
import type { InstanceSnapshot } from "../../instance/state/InstanceStateSnapshot.js";
import type { WorkerProtocolClient, WorkerHandshakeResult } from "../protocol/WorkerProtocolClient.js";
import type { WorkerRpcBridge } from "../rpc/WorkerRpcBridge.js";
import type { WorkerRpcChannel } from "../rpc/WorkerRpcChannel.js";
import type { WorkerToolCatalog } from "../tool/WorkerToolCatalog.js";
import type { ResolvedWorkerInstanceConfig } from "./WorkerInstanceConfig.js";
import { getErrorCode, isKnownErrorCode, readReverseErrorMessage, wrapWorkerCommandError } from "./WorkerInstanceError.js";
import { toEventData } from "./WorkerInstanceEvent.js";

interface WorkerInstanceConnectionOptions {
    appendEvent(type: InstanceEventInput["type"], data?: JsonValue): Promise<unknown>;
    applyStateUpdate(update: InstanceStateUpdate): Promise<InstanceSnapshot>;
    catalog: WorkerToolCatalog;
    config: ResolvedWorkerInstanceConfig;
    protocolClient: WorkerProtocolClient;
    rpcBridge: WorkerRpcBridge;
    snapshot(): InstanceSnapshot;
}

export class WorkerInstanceConnection {
    readonly #appendEvent: WorkerInstanceConnectionOptions["appendEvent"];
    readonly #applyStateUpdate: WorkerInstanceConnectionOptions["applyStateUpdate"];
    readonly #catalog: WorkerToolCatalog;
    readonly #config: ResolvedWorkerInstanceConfig;
    readonly #protocolClient: WorkerProtocolClient;
    readonly #rpcBridge: WorkerRpcBridge;
    readonly #snapshot: WorkerInstanceConnectionOptions["snapshot"];
    #handshake?: WorkerHandshakeResult;
    #intentionalRpcCloseDepth = 0;
    #reconnectPromise?: Promise<InstanceSnapshot>;
    #reverseStatus?: ReverseInstanceStatus;
    #workspacePath?: WorkspacePath;

    constructor(options: WorkerInstanceConnectionOptions) {
        this.#appendEvent = options.appendEvent;
        this.#applyStateUpdate = options.applyStateUpdate;
        this.#catalog = options.catalog;
        this.#config = options.config;
        this.#protocolClient = options.protocolClient;
        this.#rpcBridge = options.rpcBridge;
        this.#snapshot = options.snapshot;
        if (this.#config.managementMode === "selfManaged") {
            this.#reverseStatus = {
                availability: "offline",
                enrollmentState: "pending",
                managementMode: "selfManaged"
            };
        }
        this.#rpcBridge.onDisconnect((error) => {
            void this.#handleRpcDisconnect(error);
        });
    }

    get connected(): boolean {
        return this.#rpcBridge.connected;
    }

    get handshake(): WorkerHandshakeResult | undefined {
        return this.#handshake;
    }

    get workspacePath(): WorkspacePath | undefined {
        return this.#workspacePath;
    }

    snapshotReverse(): ReverseInstanceStatus | undefined {
        return this.#reverseStatus === undefined ? undefined : { ...this.#reverseStatus };
    }

    setWorkspacePath(workspacePath: WorkspacePath | string): void {
        this.#workspacePath = asWorkspacePath(workspacePath);
    }

    clearHandshake(): void {
        this.#handshake = undefined;
    }

    async connectStarted(): Promise<InstanceSnapshot> {
        try {
            await this.#rpcBridge.connect();
            await this.#protocolClient.ping();
            this.#handshake = await this.#protocolClient.handshake(this.#config.handshake);
            const tools = await this.#protocolClient.listTools();
            const refreshedTools = this.#catalog.refresh(tools.tools);
            await this.#appendEvent("worker.rpcConnected");
            await this.#appendEvent("worker.schemaRefreshed", toEventData({ toolCount: refreshedTools.length }));
            await this.#appendEvent("instance.started", {
                workspace: this.#handshake.workspace,
                workerVersion: this.#handshake.workerVersion
            });
            await this.#applyStateUpdate({ daemonState: "running", lastErrorCode: undefined });
            return await this.#applyStateUpdate({ connectionState: "connected" });
        } catch (error) {
            const wrappedError = wrapWorkerCommandError(
                error,
                errorCodes.coreWorkerHandshakeFailed,
                `Worker handshake failed for instance ${this.#config.name}.`,
                this.#config.name
            );
            this.closeBridge();
            this.#handshake = undefined;
            await this.#applyStateUpdate({
                connectionState: "disconnected",
                daemonState: "running",
                lastErrorCode: getErrorCode(wrappedError, errorCodes.coreWorkerHandshakeFailed)
            });
            if (wrappedError !== error) throw wrappedError;
            if (isKnownErrorCode(error)) throw error;
            throw createError({
                code: errorCodes.coreWorkerHandshakeFailed,
                cause: error,
                message: `Worker handshake failed for instance ${this.#config.name}.`,
                retryable: false,
                details: { instance: this.#config.name }
            });
        }
    }

    async close(): Promise<void> {
        this.closeBridge();
        this.#handshake = undefined;
        if (this.#config.managementMode === "selfManaged") {
            this.markReverseOffline();
        }
        await this.#applyStateUpdate({ connectionState: "disconnected", lastErrorCode: undefined });
    }

    async setReverseEnrollmentState(enrollmentState: ReverseEnrollmentState): Promise<InstanceSnapshot> {
        this.#requireSelfManaged();
        this.#reverseStatus = {
            ...(this.#reverseStatus ?? {
                availability: "offline",
                managementMode: "selfManaged"
            }),
            enrollmentState
        };
        await this.#appendEvent("reverse.enrollmentChanged", toEventData({ enrollmentState }));
        return this.#snapshot();
    }

    async acceptReverseChannel(
        channel: WorkerRpcChannel,
        input: { connectedAt?: string; generation: number; transport: ReverseTransport }
    ): Promise<InstanceSnapshot> {
        this.#requireSelfManaged();
        const previousGeneration = this.#reverseStatus?.generation ?? 0;
        if (!Number.isInteger(input.generation) || input.generation <= previousGeneration) {
            channel.close();
            throw createError({
                code: errorCodes.reverseGenerationInvalid,
                details: {
                    generation: input.generation,
                    instance: this.#config.name,
                    previousGeneration
                },
                message: `Reverse connection generation must be greater than ${previousGeneration}.`,
                retryable: true
            });
        }

        const connectedAt = input.connectedAt ?? new Date().toISOString();
        this.#config.rpcConnector?.attach?.(channel);
        await this.#rpcBridge.replaceChannel(channel);
        this.#reverseStatus = {
            availability: "online",
            connectedAt,
            enrollmentState: "enrolled",
            generation: input.generation,
            lastSeenAt: connectedAt,
            managementMode: "selfManaged",
            transport: input.transport
        };
        await this.#appendEvent(
            "reverse.connected",
            toEventData({ generation: input.generation, transport: input.transport })
        );
        await this.#appendEvent(
            "reverse.transportChanged",
            toEventData({ generation: input.generation, transport: input.transport })
        );
        return await this.refreshRunningStatus(undefined, "connecting");
    }

    async reconnectRpc(): Promise<InstanceSnapshot> {
        if (this.#config.managementMode === "selfManaged" && !this.#rpcBridge.connected) {
            throw createError({
                code: errorCodes.reverseTransportUnavailable,
                details: { instance: this.#config.name },
                message: `Reverse instance ${this.#config.name} is offline.`,
                retryable: true
            });
        }
        if (this.#reconnectPromise !== undefined) {
            return await this.#reconnectPromise;
        }

        this.#reconnectPromise = this.refreshRunningStatus(this.#snapshot().pid, "reconnecting").finally(() => {
            this.#reconnectPromise = undefined;
        });
        return await this.#reconnectPromise;
    }

    async refreshRunningStatus(
        pid?: number,
        connectionState: "connecting" | "reconnecting" = this.#snapshot().connectionState === "disconnected" ? "connecting" : "reconnecting"
    ): Promise<InstanceSnapshot> {
        const shouldEmitRpcLifecycleEvents = this.#snapshot().connectionState !== "connected";

        await this.#applyStateUpdate({
            connectionState,
            daemonState: "running",
            lastErrorCode: undefined,
            pid
        });

        try {
            await this.#rpcBridge.connect();
            await this.#protocolClient.ping();
            this.#handshake = await this.#protocolClient.handshake(this.#config.handshake);
            const tools = await this.#protocolClient.listTools();
            const refreshedTools = this.#catalog.refresh(tools.tools);
            this.#workspacePath = asWorkspacePath(this.#handshake.workspace);
            if (this.#reverseStatus !== undefined) {
                this.#reverseStatus = {
                    ...this.#reverseStatus,
                    availability: "online",
                    lastErrorCode: undefined,
                    lastErrorMessage: undefined,
                    lastSeenAt: new Date().toISOString()
                };
            }

            if (shouldEmitRpcLifecycleEvents) {
                await this.#appendEvent("worker.rpcConnected");
                await this.#appendEvent(
                    "worker.schemaRefreshed",
                    toEventData({ toolCount: refreshedTools.length })
                );
            }

            return await this.#applyStateUpdate({
                connectionState: "connected",
                daemonState: "running",
                lastErrorCode: undefined,
                pid
            });
        } catch (error) {
            const wrappedError = wrapWorkerCommandError(
                error,
                errorCodes.coreWorkerHandshakeFailed,
                `Worker handshake failed for instance ${this.#config.name}.`,
                this.#config.name
            );
            this.closeBridge();
            this.#handshake = undefined;
            if (this.#config.managementMode === "selfManaged") {
                this.markReverseOffline(wrappedError);
            }
            await this.#applyStateUpdate({
                connectionState: "failed",
                daemonState: "running",
                lastErrorCode: getErrorCode(wrappedError, errorCodes.coreWorkerHandshakeFailed),
                pid
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
                details: { instance: this.#config.name }
            });
        }
    }

    async stopSelfManaged(): Promise<InstanceSnapshot> {
        this.#requireSelfManaged();
        if (!this.#rpcBridge.connected) {
            throw createError({
                code: errorCodes.reverseSelfManagedOffline,
                details: { instance: this.#config.name },
                message: `Reverse instance ${this.#config.name} is offline.`,
                retryable: true
            });
        }

        await this.#applyStateUpdate({
            connectionState: "connected",
            daemonState: "stopping",
            lastErrorCode: undefined
        });

        try {
            await this.#protocolClient.stop();
        } catch (error) {
            await this.#applyStateUpdate({
                connectionState: "failed",
                daemonState: "failed",
                lastErrorCode: getErrorCode(error, errorCodes.coreWorkerStopFailed)
            });
            throw error;
        } finally {
            this.closeBridge();
            this.#handshake = undefined;
            this.markReverseOffline();
        }

        await this.#appendEvent("instance.stopped");
        return await this.#applyStateUpdate({
            connectionState: "disconnected",
            daemonState: "stopped",
            lastErrorCode: undefined,
            pid: undefined
        });
    }

    markReverseOffline(error?: unknown): void {
        const current = this.#reverseStatus;
        this.#reverseStatus = {
            availability: "offline",
            enrollmentState: current?.enrollmentState ?? "pending",
            ...(current?.generation === undefined ? {} : { generation: current.generation }),
            ...(error === undefined
                ? {}
                : {
                      lastErrorCode: getErrorCode(error, errorCodes.coreWorkerRpcDisconnected),
                      lastErrorMessage: readReverseErrorMessage(error)
                  }),
            lastSeenAt: new Date().toISOString(),
            managementMode: "selfManaged"
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
            retryable: false
        });
    }

    async #handleRpcDisconnect(error: unknown): Promise<void> {
        if (this.#intentionalRpcCloseDepth > 0) {
            return;
        }
        if (this.#config.managementMode === "selfManaged") {
            this.markReverseOffline(error);
            this.#handshake = undefined;
            await this.#appendEvent(
                "worker.rpcDisconnected",
                toEventData({ errorCode: getErrorCode(error, errorCodes.coreWorkerRpcDisconnected) })
            );
            await this.#appendEvent(
                "reverse.disconnected",
                toEventData({ errorCode: getErrorCode(error, errorCodes.coreWorkerRpcDisconnected) })
            );
            await this.#applyStateUpdate({
                connectionState: "disconnected",
                daemonState: "stopped",
                lastErrorCode: getErrorCode(error, errorCodes.coreWorkerRpcDisconnected),
                pid: undefined
            });
            return;
        }

        const daemonState = this.#snapshot().daemonState;
        await this.#appendEvent(
            "worker.rpcDisconnected",
            toEventData({ errorCode: getErrorCode(error, errorCodes.coreWorkerRpcDisconnected) })
        );

        this.#handshake = undefined;
        await this.#applyStateUpdate({
            connectionState: daemonState === "running" ? "reconnecting" : "disconnected",
            daemonState,
            lastErrorCode: getErrorCode(error, errorCodes.coreWorkerRpcDisconnected)
        });

        if (daemonState !== "running") {
            return;
        }

        try {
            await this.reconnectRpc();
        } catch {
            return;
        }
    }

    closeBridge(): void {
        this.#intentionalRpcCloseDepth += 1;

        try {
            this.#rpcBridge.close();
            this.#config.rpcConnector?.detach?.();
        } finally {
            this.#intentionalRpcCloseDepth -= 1;
        }
    }

}
