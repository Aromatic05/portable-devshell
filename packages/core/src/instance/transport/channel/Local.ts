import { runtimeErrorCodes } from "@portable-devshell/shared";

import { WorkerBinary } from "../../runtime/Binary.js";
import type { ChannelOptions } from "../../runtime/process/Model.js";
import {
    createCommandContext,
    type SpawnFunction,
} from "../../runtime/process/index.js";
import { TransportProcessRunner } from "../../runtime/process/Runner.js";

export interface LocalTransportOptions {
    resolveExecutable(env?: NodeJS.ProcessEnv): Promise<string>;
    spawnFunction?: SpawnFunction;
}

export class LocalTransport {
    readonly #process: TransportProcessRunner;
    readonly #resolveExecutable: LocalTransportOptions["resolveExecutable"];

    constructor(options: LocalTransportOptions) {
        this.#resolveExecutable = options.resolveExecutable;
        this.#process = new TransportProcessRunner(options.spawnFunction);
    }

    async connectChannel(options: ChannelOptions) {
        const workerCommand = new WorkerBinary(
            await this.#resolveExecutable(options.env),
        ).buildCommand("transport", options.instanceName);
        const context = createCommandContext({
            command: [workerCommand.command, ...workerCommand.args],
            instance: options.instanceName,
            operation: "connectChannel",
            provider: "local",
        });
        return this.#process.createChannel(
            this.#process.spawn(
                context,
                {
                    env: mergeEnvironment(options.env),
                    stdio: ["pipe", "pipe", "pipe"],
                },
                runtimeErrorCodes.providerFailed,
            ),
            context,
        );
    }
}

function mergeEnvironment(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
    const merged = {
        ...process.env,
        ...env,
    };
    delete merged.DEVSHELL_WORKER_INTERNAL_INSTANCE;
    delete merged.DEVSHELL_WORKER_INTERNAL_WORKSPACE;
    delete merged.DEVSHELL_WORKER_INTERNAL_SECURITY_MODE;
    return merged;
}
