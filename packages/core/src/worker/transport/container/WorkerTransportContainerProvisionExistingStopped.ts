import { createError, errorCodes, type InstanceContainerConfig } from "@portable-devshell/shared";

import {
    workerTransportContainerWorkingDirectoryArgs,
    type WorkerTransportContainerProvision,
    type WorkerTransportContainerProvisionOperations
} from "./WorkerTransportContainerProvision.js";

type ExistingStoppedContainerConfig = Extract<InstanceContainerConfig, { mode: "existingStoppedContainer" }>;

interface WorkerTransportContainerProvisionExistingStoppedOptions {
    config: ExistingStoppedContainerConfig;
    operations: WorkerTransportContainerProvisionOperations;
}

export class WorkerTransportContainerProvisionExistingStopped implements WorkerTransportContainerProvision {
    readonly #config: ExistingStoppedContainerConfig;
    readonly #operations: WorkerTransportContainerProvisionOperations;
    #adopted = false;

    constructor(options: WorkerTransportContainerProvisionExistingStoppedOptions) {
        this.#config = options.config;
        this.#operations = options.operations;
    }

    async ensureReady(operation: string): Promise<void> {
        const status = await this.#operations.readContainerStatus(this.#config.containerName);

        if (status === "missing") {
            throw this.#missingContainerError();
        }

        if (status === "running") {
            if (!this.#adopted) {
                throw this.#runningContainerUnsupportedError();
            }
            return;
        }

        await this.#operations.runProviderCommand("startContainer", ["start", this.#config.containerName]);
        this.#adopted = operation !== "status";
    }

    async isAvailable(): Promise<boolean> {
        const status = await this.#operations.readContainerStatus(this.#config.containerName);
        if (status === "running" && !this.#adopted) {
            throw this.#runningContainerUnsupportedError();
        }
        return status === "running";
    }

    async afterWorkerStop(): Promise<void> {
        if (!this.#config.adoptLifecycle) {
            return;
        }

        await this.#operations.runProviderCommand(
            "stopContainer",
            ["stop", this.#config.containerName],
            { allowNonZeroExit: true }
        );
        this.#adopted = false;
    }

    buildExecArgs(command: readonly string[], useRemoteCwd: boolean): string[] {
        return [
            "exec",
            ...workerTransportContainerWorkingDirectoryArgs(this.#operations.remoteCwd, useRemoteCwd),
            "-i",
            this.#config.containerName,
            ...command
        ];
    }

    buildShellExecArgs(commandLine: string): string[] {
        return ["exec", "-i", this.#config.containerName, "sh", "-lc", commandLine];
    }

    #missingContainerError() {
        return createError({
            code: errorCodes.coreProviderFailed,
            details: {
                containerName: this.#config.containerName,
                mode: "existingStoppedContainer",
                provider: this.#operations.provider
            },
            message: `Configured container ${this.#config.containerName} does not exist.`,
            retryable: false
        });
    }

    #runningContainerUnsupportedError() {
        return createError({
            code: errorCodes.coreProviderFailed,
            details: {
                containerName: this.#config.containerName,
                mode: "existingStoppedContainer",
                provider: this.#operations.provider,
                unsupportedMode: "runningContainer"
            },
            message: `Container ${this.#config.containerName} is already running. Running container attach is not a supported instance mode.`,
            retryable: false
        });
    }
}
