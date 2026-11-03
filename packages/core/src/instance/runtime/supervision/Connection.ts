import type { InstanceEventInput, WorkerHandshakeResult } from "../../Api.js";
import {
    Endpoint,
    createRemoteError,
    runtimeErrorCodes,
    type JsonValue,
    type ReverseEnrollmentState,
    type ReverseInstanceStatus,
    type ReverseTransport,
    type ReverseWorkerConnectionState,
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
import type { WorkerTunnel } from "../execution/capability/tunnel/Tunnel.js";
import {
    canContinueWithWorkerVersion,
    updateReverseWorker,
    type ReverseWorkerUpdateTarget,
} from "./Update.js";

const reconnectRetryDelayMs = 250;
const reverseUpgradeTimeoutMs = 120_000;

interface PendingReverseUpdate {
    target: ReverseWorkerUpdateTarget;
    generation: number;
    timer: ReturnType<typeof setTimeout>;
}

interface WorkerInstanceConnectionOptions {
    appendEvent(
        type: InstanceEventInput["type"],
        data?: JsonValue,
    ): Promise<unknown>;
    applyStateUpdate(update: InstanceStateUpdate, isCurrent?: () => boolean): Promise<InstanceSnapshot>;
    config: ResolvedWorkerInstanceConfig;
    protocolClient: WorkerProtocolClient;
    endpoint: Endpoint;
    metadataChanged(): void;
    snapshot(): InstanceSnapshot;
    transportConnection: TransportConnection;
    tunnel: WorkerTunnel;
}

export class WorkerInstanceConnection {
    readonly #appendEvent: WorkerInstanceConnectionOptions["appendEvent"];
    readonly #applyStateUpdate: WorkerInstanceConnectionOptions["applyStateUpdate"];
    readonly #config: ResolvedWorkerInstanceConfig;
    readonly #protocolClient: WorkerProtocolClient;
    readonly #endpoint: Endpoint;
    readonly #metadataChanged: WorkerInstanceConnectionOptions["metadataChanged"];
    readonly #snapshot: WorkerInstanceConnectionOptions["snapshot"];
    readonly #transportConnection: TransportConnection;
    readonly #tunnel: WorkerTunnel;
    readonly #unsubscribeAttach: () => void;
    #closed = false;
    #handshake?: WorkerHandshakeResult;
    #intentionalTransportCloseDepth = 0;
    #reconnectPromise?: Promise<InstanceSnapshot>;
    #reverseStatus?: ReverseInstanceStatus;
    #connectionOwner = {};
    #refreshOwner?: object;
    #reverseReadyIdentity?: object;
    #reverseUpdate?: PendingReverseUpdate;
    #signalReverseState?: (state: ReverseWorkerConnectionState) => void;

    constructor(options: WorkerInstanceConnectionOptions) {
        this.#appendEvent = options.appendEvent;
        this.#applyStateUpdate = options.applyStateUpdate;
        this.#config = options.config;
        this.#protocolClient = options.protocolClient;
        this.#endpoint = options.endpoint;
        this.#metadataChanged = options.metadataChanged;
        this.#snapshot = options.snapshot;
        this.#transportConnection = options.transportConnection;
        this.#tunnel = options.tunnel;
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
        this.#metadataChanged();
    }

    async connectStarted(): Promise<InstanceSnapshot> {
        try {
            await this.#endpoint.reconnect();
            await this.#protocolClient.ping();
            this.#handshake = await this.#protocolClient.handshake(
                this.#config.handshake,
            );
            this.#metadataChanged();
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
        if (this.#reverseUpdate !== undefined) clearTimeout(this.#reverseUpdate.timer);
        this.#reverseUpdate = undefined;
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
    ): Promise<boolean> {
        this.#requireSelfManaged();
        const previousGeneration = this.#reverseStatus?.generation ?? 0;
        if (
            !Number.isSafeInteger(input.generation) ||
            input.generation <= 0 ||
            (!input.credentialReplacement && input.generation <= previousGeneration)
        ) {
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
        let verifiedHandshake: WorkerHandshakeResult | undefined;
        await this.#endpoint.reconnect({
            preserveExisting: true,
            signal: input.signal,
            verify: async (candidate) => {
                await this.#protocolClient.ping(candidate, input.signal);
                verifiedHandshake = await this.#protocolClient.handshake(
                    this.#config.handshake,
                    candidate,
                    input.signal,
                );
                const update = this.#reverseUpdate;
                if (update !== undefined && (
                    input.generation <= update.generation ||
                    verifiedHandshake.workerVersion !== update.target.version ||
                    verifiedHandshake.workerSha256 !== update.target.sha256
                )) {
                    throw new Error("Reverse Worker replacement does not match the staged version and SHA256.");
                }
            },
        });
        input.handshakeCompleted?.();
        input.signal?.throwIfAborted();
        if (verifiedHandshake === undefined) throw new Error("Reverse Worker handshake is missing.");
        const owner = {};
        this.#connectionOwner = owner;
        this.#refreshOwner = undefined;
        this.#reverseReadyIdentity = undefined;
        const identity = this.#endpoint.connectionIdentity;
        const isCurrent = () => !this.#closed && this.#connectionOwner === owner &&
            !input.signal?.aborted && identity !== undefined && this.#endpoint.connectionIdentity === identity;
        // Keep this connection-local callback after attach returns (staged is
        // not Ready). Timeout invalidates the operation owner, but may still
        // notify this same live channel. Never retain it across replacement.
        const signalState = (state: ReverseWorkerConnectionState) => {
            if (this.#closed || input.signal?.aborted || identity === undefined ||
                this.#endpoint.connectionIdentity !== identity || this.#signalReverseState !== signalState) return;
            try {
                input.signalState?.(state);
            } catch (error) {
                console.warn(`Reverse Worker state delivery failed for ${this.#config.name}:`, error);
            }
        };
        this.#signalReverseState = signalState;
        await this.#applyStateUpdate({ connectionState: "connecting", daemonState: "running" }, isCurrent);
        if (!isCurrent()) return false;
        this.#handshake = verifiedHandshake;
        this.#metadataChanged();
        this.#reverseStatus = {
            availability: "online",
            connectedAt,
            enrollmentState: "enrolled",
            generation: input.generation,
            lastSeenAt: connectedAt,
            managementMode: "selfManaged",
            transport: input.transport,
        };
        try {
            await this.#appendEvent(
                "reverse.connected",
                toEventData({
                    generation: input.generation,
                    transport: input.transport,
                }),
            );
            if (!isCurrent()) return false;
            await this.#appendEvent(
                "reverse.transportChanged",
                toEventData({
                    generation: input.generation,
                    transport: input.transport,
                }),
            );
            if (!isCurrent()) return false;
            await this.#appendEvent("worker.transportConnected");
            // This channel can carry the update, but it is not final Ready when
            // the Worker still needs replacement. Only the new handshake may
            // promote the instance and acknowledge readiness to the Worker CLI.
            if (!isCurrent()) return false;
            // A staged target survives disconnects and is accepted only by the
            // candidate verifier above. Ordinary refresh never completes it.
            const completingUpdate = this.#reverseUpdate;
            if (completingUpdate === undefined) {
                try {
                    const target = await updateReverseWorker(this.#tunnel, this.#config.name, verifiedHandshake, {
                        generation: input.generation,
                        signal: input.signal,
                        isCurrent,
                        beforeRestart: (target) => {
                            if (!isCurrent()) throw new Error("Reverse Worker update connection was superseded.");
                            const update: PendingReverseUpdate = {
                                target,
                                generation: input.generation,
                                timer: setTimeout(() => {
                                    void this.#expireReverseUpdate(update).catch(() => undefined);
                                }, reverseUpgradeTimeoutMs),
                            };
                            update.timer.unref();
                            this.#reverseUpdate = update;
                        },
                    });
                    if (!isCurrent()) return false;
                    if (target !== undefined) {
                        // Report progress after the staging reply. WSS ingress
                        // sends it only to v3 peers; v2 keeps ACK/Ready semantics.
                        signalState({ state: "upgrading" });
                        return false;
                    }
                } catch (error) {
                    if (!isCurrent()) return false;
                    console.warn(`Reverse Worker update failed for ${this.#config.name}:`, error);
                    // Once EOF could have launched the helper, only the target
                    // generation may complete negotiation, even if its reply was lost.
                    if (this.#reverseUpdate !== undefined || !canContinueWithWorkerVersion(
                        verifiedHandshake, this.#config.handshake.protocolRange,
                    )) throw error;
                }
            }
            if (!isCurrent()) return false;
            const snapshot = await this.#applyStateUpdate({
                connectionState: "connected",
                daemonState: "running",
                lastErrorCode: undefined,
                lastErrorMessage: undefined,
            }, isCurrent);
            if (isCurrent() && snapshot.ready) {
                this.#reverseReadyIdentity = identity;
                if (completingUpdate !== undefined) {
                    clearTimeout(completingUpdate.timer);
                    this.#reverseUpdate = undefined;
                }
            }
            return isCurrent() && snapshot.ready;
        } catch (error) {
            if (!isCurrent()) return false;
            await this.#applyStateUpdate({
                connectionState: "failed",
                lastErrorCode: getErrorCode(error, runtimeErrorCodes.workerHandshakeFailed),
                lastErrorMessage: readErrorMessage(error),
            }, isCurrent);
            if (isCurrent()) signalState({ state: "failed", message: readErrorMessage(error) });
            throw error;
        }
    }

    async #expireReverseUpdate(update: PendingReverseUpdate): Promise<void> {
        if (this.#reverseUpdate !== update || this.#closed) return;
        const owner = {};
        this.#connectionOwner = owner;
        this.#refreshOwner = undefined;
        this.#reverseReadyIdentity = undefined;
        const signalState = this.#signalReverseState;
        const isCurrent = () => this.#reverseUpdate === update && this.#connectionOwner === owner && !this.#closed;
        const message = "Timed out waiting for the staged Reverse Worker version and SHA256.";
        // Retain the exact target for a late successful replacement; expiry
        // terminates waiting, and never blesses the old Worker via refresh.
        await this.#applyStateUpdate({
            connectionState: "failed",
            lastErrorCode: runtimeErrorCodes.workerHandshakeFailed,
            lastErrorMessage: message,
        }, isCurrent);
        // Best effort only: a disconnected/old Worker cannot be promised this
        // signal. Control's failed state remains observable independently.
        if (isCurrent()) signalState?.({ state: "failed", message });
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
        // Only attach negotiation can admit a self-managed link. Ping and
        // handshake on the old daemon must never bypass upgrading/staged.
        if (this.#config.managementMode === "selfManaged" && (
            this.#reverseReadyIdentity === undefined ||
            this.#reverseReadyIdentity !== this.#endpoint.connectionIdentity
        )) return this.#snapshot();
        const owner = this.#connectionOwner;
        const generation = this.#reverseStatus?.generation;
        const refreshOwner = {};
        this.#refreshOwner = refreshOwner;
        let identity = this.#endpoint.connectionIdentity;
        const ownsOperation = () => !this.#closed && this.#connectionOwner === owner &&
            this.#refreshOwner === refreshOwner && this.#reverseStatus?.generation === generation;
        const isCurrent = () => ownsOperation() && this.#endpoint.connectionIdentity === identity;
        const shouldEmitTransportLifecycleEvents =
            connectionState !== "connected";

        await this.#applyStateUpdate({
            connectionState,
            daemonState: "running",
            lastErrorCode: undefined,
            lastErrorMessage: undefined,
            pid,
        }, isCurrent);

        try {
            if (!isCurrent()) return this.#snapshot();
            if (!this.#endpoint.connected) {
                await this.#endpoint.reconnect();
                if (!ownsOperation()) return this.#snapshot();
                identity = this.#endpoint.connectionIdentity;
            }
            await this.#protocolClient.ping();
            if (!isCurrent()) return this.#snapshot();
            const handshake = await this.#protocolClient.handshake(
                this.#config.handshake,
            );
            if (!isCurrent()) return this.#snapshot();
            this.#handshake = handshake;
            this.#metadataChanged();
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

            if (!isCurrent()) return this.#snapshot();
            return await this.#applyStateUpdate({
                connectionState: "connected",
                daemonState: "running",
                lastErrorCode: undefined,
                lastErrorMessage: undefined,
                pid,
            }, isCurrent);
        } catch (error) {
            // A reply (including failure) belongs to the exact link and
            // refresh that issued it, not whichever gateway is current now.
            if (!isCurrent()) return this.#snapshot();
            const wrappedError = wrapWorkerCommandError(
                error,
                runtimeErrorCodes.workerHandshakeFailed,
                `Worker handshake failed for instance ${this.#config.name}.`,
                this.#config.name,
            );
            this.closeTransport();
            const failureOwner = this.#connectionOwner;
            const isFailureCurrent = () => !this.#closed && this.#connectionOwner === failureOwner &&
                !this.#endpoint.connected;
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
            }, isFailureCurrent);

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
        const owner = {};
        this.#connectionOwner = owner;
        this.#refreshOwner = undefined;
        this.#reverseReadyIdentity = undefined;
        this.#signalReverseState = undefined;
        this.#handshake = undefined;
        const isCurrent = () => this.#connectionOwner === owner && !this.#endpoint.connected && !this.#closed;
        if (this.#config.managementMode === "selfManaged") {
            this.markReverseOffline(error);
            await this.#appendEvent(
                "worker.transportDisconnected",
                toEventData({
                    errorCode: getErrorCode(
                        error,
                        runtimeErrorCodes.workerTransportDisconnected,
                    ),
                }),
            );
            if (!isCurrent()) return;
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
            }, isCurrent);
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

        if (!isCurrent()) return;
        await this.#applyStateUpdate({
            connectionState:
                daemonState === "running" ? "reconnecting" : "disconnected",
            daemonState,
            lastErrorCode: getErrorCode(
                error,
                runtimeErrorCodes.workerTransportDisconnected,
            ),
            lastErrorMessage: readErrorMessage(error),
        }, isCurrent);

        if (daemonState !== "running" || !isCurrent()) {
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
        this.#connectionOwner = {};
        this.#refreshOwner = undefined;
        this.#reverseReadyIdentity = undefined;
        this.#signalReverseState = undefined;
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
