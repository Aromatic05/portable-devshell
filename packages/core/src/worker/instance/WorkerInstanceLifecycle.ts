import { createError, errorCodes } from "@portable-devshell/shared";

import { WorkerCommandClient } from "../command/WorkerCommandClient.js";
import type { WorkerCommandInteractiveSession } from "../command/WorkerCommandTransport.js";
import type { InstanceEventInput } from "../../instance/event/InstanceEventBuffer.js";
import type { InstanceStateUpdate } from "../../instance/state/InstanceStateMachine.js";
import type { InstanceSnapshot } from "../../instance/state/InstanceStateSnapshot.js";
import type { WorkerInstanceConnection } from "./WorkerInstanceConnection.js";
import type { ResolvedWorkerInstanceConfig } from "./WorkerInstanceConfig.js";
import {
    getErrorCode,
    readErrorMessage,
    toJsonDetails,
    withInstanceDetails,
    wrapWorkerCommandError
} from "./WorkerInstanceError.js";
import { parseWorkerStatus } from "./WorkerInstanceStatus.js";

interface WorkerInstanceLifecycleOptions {
    appendEvent(type: InstanceEventInput["type"]): Promise<unknown>;
    applyStateUpdate(update: InstanceStateUpdate): Promise<InstanceSnapshot>;
    commandClient?: WorkerCommandClient;
    config: ResolvedWorkerInstanceConfig;
    connection: WorkerInstanceConnection;
}

export class WorkerInstanceLifecycle {
    readonly #appendEvent: WorkerInstanceLifecycleOptions["appendEvent"];
    readonly #applyStateUpdate: WorkerInstanceLifecycleOptions["applyStateUpdate"];
    readonly #commandClient?: WorkerCommandClient;
    readonly #config: ResolvedWorkerInstanceConfig;
    readonly #connection: WorkerInstanceConnection;
    #operationTail: Promise<void> = Promise.resolve();

    constructor(options: WorkerInstanceLifecycleOptions) {
        this.#appendEvent = options.appendEvent;
        this.#applyStateUpdate = options.applyStateUpdate;
        this.#commandClient = options.commandClient;
        this.#config = options.config;
        this.#connection = options.connection;
    }

    async start(): Promise<InstanceSnapshot> {
        return await this.#runExclusive(async () => await this.#start());
    }

    async startInteractive(interactiveSession?: WorkerCommandInteractiveSession): Promise<InstanceSnapshot> {
        return await this.#runExclusive(async () => await this.#start(interactiveSession));
    }

    async #start(interactiveSession?: WorkerCommandInteractiveSession): Promise<InstanceSnapshot> {
        if (this.#config.managementMode === "selfManaged") {
            throw createError({
                code: errorCodes.reverseSelfManagedLifecycle,
                details: { instance: this.#config.name, operation: "start" },
                message: `Instance ${this.#config.name} is self-managed; start it on the remote machine.`,
                retryable: false
            });
        }

        await this.#applyStateUpdate({
            connectionState: "disconnected",
            daemonState: "starting",
            lastErrorCode: undefined,
            lastErrorMessage: undefined
        });

        try {
            const startResult = await this.#requireCommandClient().start(interactiveSession);
            if (startResult.exitCode !== 0) {
                throw createError({
                    code: errorCodes.coreWorkerStartFailed,
                    message: `Worker start failed for instance ${this.#config.name}.`,
                    retryable: false,
                    details: toJsonDetails(withInstanceDetails(startResult.details, this.#config.name))
                });
            }
        } catch (error) {
            const wrappedError = wrapWorkerCommandError(
                error,
                errorCodes.coreWorkerStartFailed,
                `Worker start failed for instance ${this.#config.name}.`,
                this.#config.name
            );
            await this.#applyStateUpdate({
                connectionState: "disconnected",
                daemonState: "stopped",
                lastErrorCode: getErrorCode(wrappedError, errorCodes.coreWorkerStartFailed),
                lastErrorMessage: readErrorMessage(wrappedError)
            });
            throw wrappedError;
        }

        await this.#applyStateUpdate({ connectionState: "connecting" });
        return await this.#connection.connectStarted();
    }

    async stop(): Promise<InstanceSnapshot> {
        return await this.#runExclusive(async () => await this.#stop());
    }

    async #stop(): Promise<InstanceSnapshot> {
        if (this.#config.managementMode === "selfManaged") {
            throw createError({
                code: errorCodes.reverseSelfManagedLifecycle,
                details: { instance: this.#config.name, operation: "stop" },
                message: `Instance ${this.#config.name} is self-managed; stop it on the remote machine.`,
                retryable: false
            });
        }

        await this.#applyStateUpdate({
            connectionState: "disconnected",
            daemonState: "stopping",
            lastErrorCode: undefined,
            lastErrorMessage: undefined
        });
        this.#connection.closeBridge();
        this.#connection.clearHandshake();
        try {
            const result = await this.#requireCommandClient().stop();
            if (result.exitCode !== 0) {
                throw createError({
                    code: errorCodes.coreWorkerStopFailed,
                    message: `Worker stop failed for instance ${this.#config.name}.`,
                    retryable: false,
                    details: toJsonDetails(withInstanceDetails(result.details, this.#config.name))
                });
            }
        } catch (error) {
            const wrappedError = wrapWorkerCommandError(
                error,
                errorCodes.coreWorkerStopFailed,
                `Worker stop failed for instance ${this.#config.name}.`,
                this.#config.name
            );
            await this.#refreshStatus().catch(() => undefined);
            await this.#applyStateUpdate({
                lastErrorCode: getErrorCode(wrappedError, errorCodes.coreWorkerStopFailed),
                lastErrorMessage: readErrorMessage(wrappedError)
            });
            throw wrappedError;
        }

        await this.#appendEvent("instance.stopped");
        await this.#applyStateUpdate({ daemonState: "stopped" });
        return await this.#applyStateUpdate({
            connectionState: "disconnected",
            lastErrorCode: undefined,
            lastErrorMessage: undefined
        });
    }

    async refreshStatus(): Promise<InstanceSnapshot> {
        return await this.#runExclusive(async () => await this.#refreshStatus());
    }

    async reconnectRpc(): Promise<InstanceSnapshot> {
        return await this.#runExclusive(async () => await this.#connection.reconnectRpc());
    }

    async closeConnection(): Promise<void> {
        await this.#runExclusive(async () => await this.#connection.close());
    }

    async retireRuntime(): Promise<void> {
        await this.#runExclusive(async () => {
            if (this.#commandClient === undefined) return;
            const result = await this.#commandClient.retireRuntime();
            if (result.exitCode !== 0) {
                throw createError({
                    code: errorCodes.coreProviderFailed,
                    message: `Worker runtime retirement failed for instance ${this.#config.name}.`,
                    retryable: false,
                    details: toJsonDetails(withInstanceDetails(result.details, this.#config.name))
                });
            }
        });
    }

    async retireProviderResources(): Promise<void> {
        await this.#runExclusive(async () => {
            await this.#commandClient?.retireProviderResources();
        });
    }

    async #refreshStatus(): Promise<InstanceSnapshot> {
        if (this.#config.managementMode === "selfManaged") {
            if (!this.#connection.connected) {
                this.#connection.markReverseOffline();
                this.#connection.clearHandshake();
                return await this.#applyStateUpdate({
                    connectionState: "disconnected",
                    daemonState: "stopped",
                    lastErrorCode: undefined,
                    lastErrorMessage: undefined,
                    pid: undefined
                });
            }

            return await this.#connection.refreshRunningStatus(undefined);
        }

        const status = await this.#readWorkerStatus();

        switch (status.daemonState) {
            case "stopped":
            case "stale":
                this.#connection.closeBridge();
                this.#connection.clearHandshake();
                return await this.#applyStateUpdate({
                    connectionState: "disconnected",
                    daemonState: status.daemonState,
                    lastErrorCode: undefined,
                    lastErrorMessage: undefined,
                    pid: status.pid
                });
            case "running":
                return await this.#connection.refreshRunningStatus(status.pid);
            default:
                return await this.#applyStateUpdate({
                    connectionState: "failed",
                    daemonState: "failed",
                    lastErrorCode: errorCodes.coreWorkerStatusFailed,
                    lastErrorMessage: `Worker returned an unsupported status for instance ${this.#config.name}.`,
                    pid: status.pid
                });
        }
    }

    #requireCommandClient(): WorkerCommandClient {
        if (this.#commandClient !== undefined) {
            return this.#commandClient;
        }

        throw createError({
            code: errorCodes.coreProviderFailed,
            details: { instance: this.#config.name },
            message: `Instance ${this.#config.name} does not have a controller-managed command transport.`,
            retryable: false
        });
    }

    async #runExclusive<T>(factory: () => Promise<T>): Promise<T> {
        const operation = this.#operationTail.then(factory, factory);
        this.#operationTail = operation.then(
            () => undefined,
            () => undefined
        );
        return await operation;
    }

    async #readWorkerStatus(): Promise<{
        daemonState: "running" | "stale" | "stopped";
        pid?: number;
    }> {
        let result: Awaited<ReturnType<WorkerCommandClient["status"]>>;

        try {
            result = await this.#requireCommandClient().status();
        } catch (error) {
            const wrappedError = wrapWorkerCommandError(
                error,
                errorCodes.coreWorkerStatusFailed,
                `Worker status failed for instance ${this.#config.name}.`,
                this.#config.name
            );
            await this.#applyStateUpdate({
                connectionState: "failed",
                daemonState: "failed",
                lastErrorCode: getErrorCode(wrappedError, errorCodes.coreWorkerStatusFailed),
                lastErrorMessage: readErrorMessage(wrappedError)
            });
            throw wrappedError;
        }

        if (result.exitCode !== 0) {
            const error = createError({
                code: errorCodes.coreWorkerStatusFailed,
                message: `Worker status failed for instance ${this.#config.name}.`,
                retryable: false,
                details: toJsonDetails(withInstanceDetails(result.details, this.#config.name))
            });
            await this.#applyStateUpdate({
                connectionState: "failed",
                daemonState: "failed",
                lastErrorCode: error.code,
                lastErrorMessage: readErrorMessage(error)
            });
            throw error;
        }

        try {
            return parseWorkerStatus(result.stdout, this.#config.name);
        } catch (error) {
            await this.#applyStateUpdate({
                connectionState: "failed",
                daemonState: "failed",
                lastErrorCode: getErrorCode(error, errorCodes.coreWorkerStatusFailed),
                lastErrorMessage: readErrorMessage(error)
            });
            throw error;
        }
    }
}
