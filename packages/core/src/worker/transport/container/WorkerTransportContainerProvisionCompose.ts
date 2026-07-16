import type { InstanceContainerConfig } from "@portable-devshell/shared";

import {
    workerTransportContainerWorkingDirectoryArgs,
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

    async afterWorkerStop(): Promise<void> {}

    buildExecArgs(command: readonly string[], useRemoteCwd: boolean): string[] {
        return this.#buildComposeArgs([
            "exec",
            "-T",
            ...workerTransportContainerWorkingDirectoryArgs(this.#operations.remoteCwd, useRemoteCwd),
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
