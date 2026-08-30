import type { InstanceContainerConfig } from "@portable-devshell/shared";

import {
    workerTransportContainerEnvironmentArgs,
    type WorkerTransportContainerProvision,
    type WorkerTransportContainerProvisionOperations
} from "./WorkerTransportContainerProvision.js";

type ComposeContainerConfig = Extract<InstanceContainerConfig, { mode: "compose" }>;

interface WorkerTransportContainerProvisionComposeOptions {
    config: ComposeContainerConfig;
    operations: WorkerTransportContainerProvisionOperations;
}

export class WorkerTransportContainerProvisionCompose implements WorkerTransportContainerProvision {
    readonly #config: ComposeContainerConfig;
    readonly #operations: WorkerTransportContainerProvisionOperations;
    #startedForRuntimeRetire = false;

    constructor(options: WorkerTransportContainerProvisionComposeOptions) {
        this.#config = options.config;
        this.#operations = options.operations;
    }

    async ensureReady(): Promise<void> {
        if (await this.isAvailable()) {
            return;
        }

        await this.#operations.runProviderCommand(
            "composeUp",
            this.#buildComposeArgs(["up", "-d", this.#config.compose.service])
        );
    }

    async isAvailable(): Promise<boolean> {
        const result = await this.#operations.runProviderCommand(
            "composePs",
            this.#buildComposeArgs(["ps", "-q", this.#config.compose.service]),
            { allowNonZeroExit: true }
        );
        return result.exitCode === 0 && result.stdout.trim().length > 0;
    }

    async prepareRuntimeRetire(): Promise<boolean> {
        if (await this.isAvailable()) return true;
        const existing = await this.#operations.runProviderCommand(
            "composePsAll",
            this.#buildComposeArgs(["ps", "-a", "-q", this.#config.compose.service]),
            { allowNonZeroExit: true }
        );
        if (existing.exitCode !== 0 || existing.stdout.trim().length === 0) return false;
        await this.#operations.runProviderCommand(
            "composeStartForRetire",
            this.#buildComposeArgs(["start", this.#config.compose.service])
        );
        this.#startedForRuntimeRetire = true;
        return true;
    }

    async finishRuntimeRetire(): Promise<void> {
        if (!this.#startedForRuntimeRetire) return;
        try {
            await this.#operations.runProviderCommand(
                "composeStopAfterRetire",
                this.#buildComposeArgs(["stop", this.#config.compose.service])
            );
        } finally {
            this.#startedForRuntimeRetire = false;
        }
    }

    async afterWorkerStop(): Promise<void> {}

    async retire(): Promise<void> {}

    buildExecArgs(
        command: readonly string[],
        environmentKeys: readonly string[] = []
    ): string[] {
        return this.#buildComposeArgs([
            "exec",
            "-T",
            ...workerTransportContainerEnvironmentArgs(environmentKeys),
            this.#config.compose.service,
            ...command
        ]);
    }

    buildShellExecArgs(commandLine: string): string[] {
        return this.#buildComposeArgs([
            "exec",
            "-T",
            this.#config.compose.service,
            "sh",
            "-lc",
            commandLine
        ]);
    }

    #buildComposeArgs(args: readonly string[]): string[] {
        return [
            "compose",
            "-f",
            this.#config.compose.file,
            ...(this.#config.compose.projectName === undefined ? [] : ["-p", this.#config.compose.projectName]),
            ...args
        ];
    }
}
