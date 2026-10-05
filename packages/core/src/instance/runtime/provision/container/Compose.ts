import type { InstanceContainerConfig } from "@portable-devshell/shared";

import {
    type ContainerProvision,
    type ContainerProvisionOperations,
} from "./Provision.js";

type ComposeContainerConfig = Extract<
    InstanceContainerConfig,
    { mode: "compose" }
>;

interface ContainerProvisionComposeOptions {
    config: ComposeContainerConfig;
    operations: ContainerProvisionOperations;
}

export class ContainerProvisionCompose implements ContainerProvision {
    readonly #config: ComposeContainerConfig;
    readonly #operations: ContainerProvisionOperations;
    #startedForRuntimeRetire = false;

    constructor(options: ContainerProvisionComposeOptions) {
        this.#config = options.config;
        this.#operations = options.operations;
    }

    async ensureReady(): Promise<void> {
        if (await this.isAvailable()) {
            return;
        }

        await this.#operations.runProviderCommand(
            "composeUp",
            this.#buildComposeArgs(["up", "-d", this.#config.compose.service]),
        );
    }

    async isAvailable(): Promise<boolean> {
        const result = await this.#operations.runProviderCommand(
            "composePs",
            this.#buildComposeArgs(["ps", "-q", this.#config.compose.service]),
            { allowNonZeroExit: true },
        );
        return result.exitCode === 0 && result.stdout.trim().length > 0;
    }

    async prepareRuntimeRetire(): Promise<boolean> {
        if (await this.isAvailable()) return true;
        const existing = await this.#operations.runProviderCommand(
            "composePsAll",
            this.#buildComposeArgs([
                "ps",
                "-a",
                "-q",
                this.#config.compose.service,
            ]),
            { allowNonZeroExit: true },
        );
        if (existing.exitCode !== 0 || existing.stdout.trim().length === 0)
            return false;
        await this.#operations.runProviderCommand(
            "composeStartForRetire",
            this.#buildComposeArgs(["start", this.#config.compose.service]),
        );
        this.#startedForRuntimeRetire = true;
        return true;
    }

    async finishRuntimeRetire(): Promise<void> {
        if (!this.#startedForRuntimeRetire) return;
        try {
            await this.#operations.runProviderCommand(
                "composeStopAfterRetire",
                this.#buildComposeArgs(["stop", this.#config.compose.service]),
            );
        } finally {
            this.#startedForRuntimeRetire = false;
        }
    }

    async afterWorkerStop(): Promise<void> {}

    async retire(): Promise<void> {}



    #buildComposeArgs(args: readonly string[]): string[] {
        return [
            "compose",
            "-f",
            this.#config.compose.file,
            ...(this.#config.compose.projectName === undefined
                ? []
                : ["-p", this.#config.compose.projectName]),
            ...args,
        ];
    }
}
