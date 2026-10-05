import { createRemoteError, runtimeErrorCodes } from "@portable-devshell/shared";

import type { WorkerCommandClient } from "../execution/Command.js";
import { getErrorCode, readErrorMessage, withInstanceDetails, wrapWorkerCommandError } from "../execution/Error.js";
import { toJsonDetails } from "../../transport/endpoint/channel/worker/Error.js";
import type { ReverseExecution } from "../execution/provider/Reverse.js";
import type { ResolvedWorkerInstanceConfig } from "../provision/Config.js";
import type { InstanceSnapshot, InstanceStateUpdate } from "./State.js";
import { parseWorkerStatus } from "./Status.js";
import type { WorkerInstanceConnection } from "./Connection.js";

export class WorkerInstanceSupervision {
    readonly #applyStateUpdate: (
        update: InstanceStateUpdate,
    ) => Promise<InstanceSnapshot>;
    readonly #commandClient?: WorkerCommandClient;
    readonly #config: ResolvedWorkerInstanceConfig;
    readonly #connection: WorkerInstanceConnection;
    readonly #reverse?: ReverseExecution;

    constructor(options: {
        applyStateUpdate(
            update: InstanceStateUpdate,
        ): Promise<InstanceSnapshot>;
        commandClient?: WorkerCommandClient;
        config: ResolvedWorkerInstanceConfig;
        connection: WorkerInstanceConnection;
        reverse?: ReverseExecution;
    }) {
        this.#applyStateUpdate = options.applyStateUpdate;
        this.#commandClient = options.commandClient;
        this.#config = options.config;
        this.#connection = options.connection;
        this.#reverse = options.reverse;
    }

    async refreshStatus(): Promise<InstanceSnapshot> {
        if (this.#reverse !== undefined)
            return await this.#reverse.refreshStatus();

        const status = await this.#readWorkerStatus();
        switch (status.daemonState) {
            case "stopped":
            case "stale":
                this.#connection.closeTransport();
                this.#connection.clearHandshake();
                return await this.#applyStateUpdate({
                    connectionState: "disconnected",
                    daemonState: status.daemonState,
                    lastErrorCode: undefined,
                    lastErrorMessage: undefined,
                    pid: status.pid,
                });
            case "running":
                return await this.#connection.refreshRunningStatus(status.pid);
        }
    }

    async reconnectTransport(): Promise<InstanceSnapshot> {
        return await this.#connection.reconnectTransport();
    }

    async close(): Promise<void> {
        await this.#connection.close();
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
                runtimeErrorCodes.workerStatusFailed,
                `Worker status failed for instance ${this.#config.name}.`,
                this.#config.name,
            );
            await this.#applyStateUpdate({
                connectionState: "failed",
                daemonState: "failed",
                lastErrorCode: getErrorCode(
                    wrappedError,
                    runtimeErrorCodes.workerStatusFailed,
                ),
                lastErrorMessage: readErrorMessage(wrappedError),
            });
            throw wrappedError;
        }

        if (result.exitCode !== 0) {
            const error = createRemoteError({
                code: runtimeErrorCodes.workerStatusFailed,
                message: `Worker status failed for instance ${this.#config.name}.`,
                retryable: false,
                details: toJsonDetails(
                    withInstanceDetails(result.details, this.#config.name),
                ),
            });
            await this.#applyStateUpdate({
                connectionState: "failed",
                daemonState: "failed",
                lastErrorCode: error.code,
                lastErrorMessage: readErrorMessage(error),
            });
            throw error;
        }

        try {
            return parseWorkerStatus(result.stdout, this.#config.name);
        } catch (error) {
            await this.#applyStateUpdate({
                connectionState: "failed",
                daemonState: "failed",
                lastErrorCode: getErrorCode(
                    error,
                    runtimeErrorCodes.workerStatusFailed,
                ),
                lastErrorMessage: readErrorMessage(error),
            });
            throw error;
        }
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
