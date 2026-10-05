import type { InstanceEventInput } from "../../Api.js";
import { createRemoteError, runtimeErrorCodes } from "@portable-devshell/shared";

import { WorkerCommandClient } from "./Command.js";
import type { WorkerCommandInteractiveSession } from "../../Api.js";

import type { InstanceStateUpdate, InstanceSnapshot } from "../supervision/State.js";
import type { WorkerInstanceConnection } from "../supervision/Connection.js";
import type { ResolvedWorkerInstanceConfig } from "../provision/Config.js";
import { getErrorCode, readErrorMessage, withInstanceDetails, wrapWorkerCommandError } from "./Error.js";
import { toJsonDetails } from "../../transport/endpoint/channel/worker/Error.js";
import type { ReverseExecution } from "./provider/Reverse.js";

interface WorkerInstanceLifecycleOptions {
    appendEvent(type: InstanceEventInput["type"]): Promise<unknown>;
    applyStateUpdate(update: InstanceStateUpdate): Promise<InstanceSnapshot>;
    commandClient?: WorkerCommandClient;
    config: ResolvedWorkerInstanceConfig;
    connection: WorkerInstanceConnection;
    refreshStatus(): Promise<InstanceSnapshot>;
    reverse?: ReverseExecution;
}

export class WorkerInstanceLifecycle {
    readonly #appendEvent: WorkerInstanceLifecycleOptions["appendEvent"];
    readonly #applyStateUpdate: WorkerInstanceLifecycleOptions["applyStateUpdate"];
    readonly #commandClient?: WorkerCommandClient;
    readonly #config: ResolvedWorkerInstanceConfig;
    readonly #connection: WorkerInstanceConnection;
    readonly #refreshStatus: WorkerInstanceLifecycleOptions["refreshStatus"];
    readonly #reverse?: ReverseExecution;

    constructor(options: WorkerInstanceLifecycleOptions) {
        this.#appendEvent = options.appendEvent;
        this.#applyStateUpdate = options.applyStateUpdate;
        this.#commandClient = options.commandClient;
        this.#config = options.config;
        this.#connection = options.connection;
        this.#refreshStatus = options.refreshStatus;
        this.#reverse = options.reverse;
    }

    async start(): Promise<InstanceSnapshot> {
        return await this.#start();
    }

    async startInteractive(
        interactiveSession?: WorkerCommandInteractiveSession,
    ): Promise<InstanceSnapshot> {
        return await this.#start(interactiveSession);
    }

    async #start(
        interactiveSession?: WorkerCommandInteractiveSession,
    ): Promise<InstanceSnapshot> {
        if (this.#reverse !== undefined) return this.#reverse.start();

        await this.#applyStateUpdate({
            connectionState: "disconnected",
            daemonState: "starting",
            lastErrorCode: undefined,
            lastErrorMessage: undefined,
        });

        try {
            const startResult =
                await this.#requireCommandClient().start(interactiveSession);
            if (startResult.exitCode !== 0) {
                throw createRemoteError({
                    code: runtimeErrorCodes.workerStartFailed,
                    message: `Worker start failed for instance ${this.#config.name}.`,
                    retryable: false,
                    details: toJsonDetails(
                        withInstanceDetails(
                            startResult.details,
                            this.#config.name,
                        ),
                    ),
                });
            }
        } catch (error) {
            const wrappedError = wrapWorkerCommandError(
                error,
                runtimeErrorCodes.workerStartFailed,
                `Worker start failed for instance ${this.#config.name}.`,
                this.#config.name,
            );
            await this.#applyStateUpdate({
                connectionState: "disconnected",
                daemonState: "stopped",
                lastErrorCode: getErrorCode(
                    wrappedError,
                    runtimeErrorCodes.workerStartFailed,
                ),
                lastErrorMessage: readErrorMessage(wrappedError),
            });
            throw wrappedError;
        }

        await this.#applyStateUpdate({ connectionState: "connecting" });
        return await this.#connection.connectStarted();
    }

    async stop(): Promise<InstanceSnapshot> {
        if (this.#reverse !== undefined) return this.#reverse.stop();

        await this.#applyStateUpdate({
            connectionState: "disconnected",
            daemonState: "stopping",
            lastErrorCode: undefined,
            lastErrorMessage: undefined,
        });
        this.#connection.closeTransport();
        this.#connection.clearHandshake();
        try {
            const result = await this.#requireCommandClient().stop();
            if (result.exitCode !== 0) {
                throw createRemoteError({
                    code: runtimeErrorCodes.workerStopFailed,
                    message: `Worker stop failed for instance ${this.#config.name}.`,
                    retryable: false,
                    details: toJsonDetails(
                        withInstanceDetails(result.details, this.#config.name),
                    ),
                });
            }
        } catch (error) {
            const wrappedError = wrapWorkerCommandError(
                error,
                runtimeErrorCodes.workerStopFailed,
                `Worker stop failed for instance ${this.#config.name}.`,
                this.#config.name,
            );
            await this.#refreshStatus().catch(() => undefined);
            await this.#applyStateUpdate({
                lastErrorCode: getErrorCode(
                    wrappedError,
                    runtimeErrorCodes.workerStopFailed,
                ),
                lastErrorMessage: readErrorMessage(wrappedError),
            });
            throw wrappedError;
        }

        await this.#appendEvent("instance.stopped");
        await this.#applyStateUpdate({ daemonState: "stopped" });
        return await this.#applyStateUpdate({
            connectionState: "disconnected",
            lastErrorCode: undefined,
            lastErrorMessage: undefined,
        });
    }

    #requireCommandClient(): WorkerCommandClient {
        if (this.#commandClient !== undefined) return this.#commandClient;
        throw createRemoteError({
            code: runtimeErrorCodes.providerFailed,
            details: { instance: this.#config.name },
            message: `Instance ${this.#config.name} does not have a controller-managed command transport.`,
            retryable: false,
        });
    }
}
