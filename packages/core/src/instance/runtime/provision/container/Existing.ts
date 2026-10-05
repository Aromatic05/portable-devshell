import {
    createRemoteError,
    runtimeErrorCodes,
    type InstanceContainerConfig,
} from "@portable-devshell/shared";

import {
    type ContainerProvision,
    type ContainerProvisionOperations,
} from "./Provision.js";

type ExistingStoppedContainerConfig = Extract<
    InstanceContainerConfig,
    { mode: "existingStoppedContainer" }
>;

interface ContainerProvisionExistingOptions {
    config: ExistingStoppedContainerConfig;
    operations: ContainerProvisionOperations;
}

export class ContainerProvisionExisting implements ContainerProvision {
    readonly #config: ExistingStoppedContainerConfig;
    readonly #operations: ContainerProvisionOperations;
    #adopted = false;
    #startedForRuntimeRetire = false;

    constructor(
        options: ContainerProvisionExistingOptions,
    ) {
        this.#config = options.config;
        this.#operations = options.operations;
    }

    async ensureReady(operation: string): Promise<void> {
        const status = await this.#operations.readContainerStatus(
            this.#config.containerName,
        );

        if (status === "missing") {
            throw this.#missingContainerError();
        }

        if (status === "running") {
            if (!this.#adopted) {
                throw this.#runningContainerUnsupportedError();
            }
            return;
        }

        await this.#operations.runProviderCommand("startContainer", [
            "start",
            this.#config.containerName,
        ]);
        this.#adopted = operation !== "status";
    }

    async isAvailable(): Promise<boolean> {
        const status = await this.#operations.readContainerStatus(
            this.#config.containerName,
        );
        if (status === "running" && !this.#adopted) {
            throw this.#runningContainerUnsupportedError();
        }
        return status === "running";
    }

    async prepareRuntimeRetire(): Promise<boolean> {
        const status = await this.#operations.readContainerStatus(
            this.#config.containerName,
        );
        if (status === "missing") return false;
        if (status === "running") return true;
        await this.#operations.runProviderCommand("startContainerForRetire", [
            "start",
            this.#config.containerName,
        ]);
        this.#startedForRuntimeRetire = true;
        return true;
    }

    async finishRuntimeRetire(): Promise<void> {
        if (!this.#startedForRuntimeRetire) return;
        try {
            await this.#operations.runProviderCommand(
                "stopContainerAfterRetire",
                ["stop", this.#config.containerName],
            );
        } finally {
            this.#startedForRuntimeRetire = false;
        }
    }

    async afterWorkerStop(): Promise<void> {
        if (!this.#config.adoptLifecycle) {
            return;
        }

        await this.#operations.runProviderCommand(
            "stopContainer",
            ["stop", this.#config.containerName],
            { allowNonZeroExit: true },
        );
        this.#adopted = false;
    }

    async retire(): Promise<void> {}



    #missingContainerError() {
        return createRemoteError({
            code: runtimeErrorCodes.providerFailed,
            details: {
                containerName: this.#config.containerName,
                mode: "existingStoppedContainer",
                provider: this.#operations.provider,
            },
            message: `Configured container ${this.#config.containerName} does not exist.`,
            retryable: false,
        });
    }

    #runningContainerUnsupportedError() {
        return createRemoteError({
            code: runtimeErrorCodes.providerFailed,
            details: {
                containerName: this.#config.containerName,
                mode: "existingStoppedContainer",
                provider: this.#operations.provider,
                unsupportedMode: "runningContainer",
            },
            message: `Container ${this.#config.containerName} is already running. Running container attach is not a supported instance mode.`,
            retryable: false,
        });
    }
}
