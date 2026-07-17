import {
    createError,
    errorCodes,
    type WorkspacePath
} from "@portable-devshell/shared";

import { WorkerCommandClient } from "../command/WorkerCommandClient.js";
import type { WorkerCommandInteractiveSession } from "../command/WorkerCommandTransport.js";
import type { InstanceEventInput } from "../../instance/event/InstanceEventBuffer.js";
import type { InstanceStateUpdate } from "../../instance/state/InstanceStateMachine.js";
import type { InstanceSnapshot } from "../../instance/state/InstanceStateSnapshot.js";
import type { WorkerInstanceConnection } from "./WorkerInstanceConnection.js";
import type { ResolvedWorkerInstanceConfig } from "./WorkerInstanceConfig.js";
import {
    getErrorCode,
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

    async start(workspacePath?: WorkspacePath | string): Promise<InstanceSnapshot> {
        return await this.#runExclusive(async () => await this.#start(workspacePath));
    }

    async startInteractive(
        workspacePath: WorkerCommandInteractiveSession | WorkspacePath | string | undefined,
        interactiveSession?: WorkerCommandInteractiveSession
    ): Promise<InstanceSnapshot> {
        return await this.#runExclusive(async () => await this.#start(
            isInteractiveSession(workspacePath) ? undefined : workspacePath,
            isInteractiveSession(workspacePath) ? workspacePath : interactiveSession
        ));
    }

    async #start(
        workspacePath?: WorkspacePath | string,
        interactiveSession?: WorkerCommandInteractiveSession
    ): Promise<InstanceSnapshot> {
        if (this.#config.managementMode === "selfManaged") {
            throw createError({
                code: errorCodes.reverseSelfManagedOffline,
                details: { instance: this.#config.name },
                message: `Instance ${this.#config.name} is self-managed and must be started on the remote machine.`,
                retryable: true
            });
        }

        const resolvedWorkspacePath = workspacePath ?? this.#config.defaultWorkspace;
        if (resolvedWorkspacePath === undefined) {
            throw createError({
                code: errorCodes.coreWorkerStartFailed,
                message: `Instance ${this.#config.name} requires a workspace to start.`,
                retryable: false,
                details: { instanceName: this.#config.name }
            });
        }

        this.#connection.setWorkspacePath(resolvedWorkspacePath);
        await this.#applyStateUpdate({
            connectionState: "disconnected",
            daemonState: "starting",
            lastErrorCode: undefined
        });

        try {
            const startResult = await this.#requireCommandClient().start(resolvedWorkspacePath, interactiveSession);
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
                lastErrorCode: getErrorCode(wrappedError, errorCodes.coreWorkerStartFailed)
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
            return await this.#connection.stopSelfManaged();
        }

        await this.#applyStateUpdate({
            connectionState: "disconnected",
            daemonState: "stopping",
            lastErrorCode: undefined
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
                lastErrorCode: getErrorCode(wrappedError, errorCodes.coreWorkerStopFailed)
            });
            throw wrappedError;
        }

        await this.#appendEvent("instance.stopped");
        await this.#applyStateUpdate({ daemonState: "stopped" });
        return await this.#applyStateUpdate({
            connectionState: "disconnected",
            lastErrorCode: undefined
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

    async #refreshStatus(): Promise<InstanceSnapshot> {
        if (this.#config.managementMode === "selfManaged") {
            if (!this.#connection.connected) {
                this.#connection.markReverseOffline();
                this.#connection.clearHandshake();
                return await this.#applyStateUpdate({
                    connectionState: "disconnected",
                    daemonState: "stopped",
                    lastErrorCode: undefined,
                    pid: undefined
                });
            }

            return await this.#connection.refreshRunningStatus(undefined);
        }

        const status = await this.#readWorkerStatus();
        if (status.workspacePath !== undefined) {
            this.#connection.setWorkspacePath(status.workspacePath);
        }

        switch (status.daemonState) {
            case "stopped":
            case "stale":
                this.#connection.closeBridge();
                this.#connection.clearHandshake();
                return await this.#applyStateUpdate({
                    connectionState: "disconnected",
                    daemonState: status.daemonState,
                    lastErrorCode: undefined,
                    pid: status.pid
                });
            case "running":
                return await this.#connection.refreshRunningStatus(status.pid);
            default:
                return await this.#applyStateUpdate({
                    connectionState: "failed",
                    daemonState: "failed",
                    lastErrorCode: errorCodes.coreWorkerStatusFailed,
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
        workspacePath?: string;
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
                lastErrorCode: getErrorCode(wrappedError, errorCodes.coreWorkerStatusFailed)
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
                lastErrorCode: error.code
            });
            throw error;
        }

        try {
            return parseWorkerStatus(result.stdout, this.#config.name);
        } catch (error) {
            await this.#applyStateUpdate({
                connectionState: "failed",
                daemonState: "failed",
                lastErrorCode: getErrorCode(error, errorCodes.coreWorkerStatusFailed)
            });
            throw error;
        }
    }
}

function isInteractiveSession(value: unknown): value is WorkerCommandInteractiveSession {
    return typeof value === "object" && value !== null && "readInput" in value && "writeOutput" in value;
}
