import type { ChildProcess, SpawnOptions } from "node:child_process";

import {
    runtimeErrorCodes,
    type Channel,
} from "@portable-devshell/shared";

import { WorkerBinary } from "../../runtime/Binary.js";
import type { ChannelOptions } from "../../runtime/process/Model.js";
import type { ProviderCommandContext } from "../../runtime/process/index.js";

export interface DockerTransportOptions {
    createChannel(child: ChildProcess, context: ProviderCommandContext): Channel;
    createInvocation(
        operation: string,
        command: readonly string[],
        instance: string,
        environmentKeys: readonly string[],
    ): { context: ProviderCommandContext };
    ensureReady(operation: string): Promise<void>;
    environment(env: NodeJS.ProcessEnv | undefined): {
        keys: string[];
        processEnv?: NodeJS.ProcessEnv;
    };
    resolveExecutable(): Promise<string>;
    spawn(
        context: ProviderCommandContext,
        options: SpawnOptions,
        errorCode?: string,
    ): ChildProcess;
}

export class DockerTransport {
    readonly #options: DockerTransportOptions;

    constructor(options: DockerTransportOptions) {
        this.#options = options;
    }

    async connectChannel(options: ChannelOptions) {
        const environment = this.#options.environment(options.env);
        await this.#options.ensureReady("connectChannel");
        const workerCommand = new WorkerBinary(
            await this.#options.resolveExecutable(),
        ).buildCommand("transport", options.instanceName);
        const invocation = this.#options.createInvocation(
            "connectChannel",
            [workerCommand.command, ...workerCommand.args],
            options.instanceName,
            environment.keys,
        );
        return this.#options.createChannel(
            this.#options.spawn(
                invocation.context,
                {
                    env: environment.processEnv,
                    stdio: ["pipe", "pipe", "pipe"],
                },
                runtimeErrorCodes.providerFailed,
            ),
            invocation.context,
        );
    }
}
