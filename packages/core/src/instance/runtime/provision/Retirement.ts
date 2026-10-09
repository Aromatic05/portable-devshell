import {
    createRemoteError,
    runtimeErrorCodes,
} from "@portable-devshell/shared";

import type { WorkerCommandClient } from "../execution/Command.js";
import type { ResolvedWorkerInstanceConfig } from "./Config.js";
import { toJsonDetails } from "../../transport/endpoint/channel/worker/Error.js";
import { withInstanceDetails } from "../execution/Error.js";

export class WorkerInstanceRetirement {
    readonly #commandClient?: WorkerCommandClient;
    readonly #config: ResolvedWorkerInstanceConfig;

    constructor(options: {
        commandClient?: WorkerCommandClient;
        config: ResolvedWorkerInstanceConfig;
    }) {
        this.#commandClient = options.commandClient;
        this.#config = options.config;
    }

    async retire(skipRuntimeRetirement = false): Promise<void> {
        const failures: unknown[] = [];
        if (!skipRuntimeRetirement)
            await this.retireRuntime().catch((error) => failures.push(error));
        await this.retireProviderResources().catch((error) => failures.push(error));
        if (failures.length > 0)
            throw new AggregateError(
                failures,
                `Instance ${this.#config.name} Worker resource retirement was incomplete.`,
            );
    }

    async retireRuntime(): Promise<void> {
        if (this.#commandClient === undefined) return;
        const result = await this.#commandClient.retireRuntime();
        if (result.exitCode === 0) return;
        throw createRemoteError({
            code: runtimeErrorCodes.providerFailed,
            message: `Worker runtime retirement failed for instance ${this.#config.name}.`,
            retryable: false,
            details: toJsonDetails(
                withInstanceDetails(result.details, this.#config.name),
            ),
        });
    }

    async retireProviderResources(): Promise<void> {
        await this.#commandClient?.retireProviderResources();
    }
}
