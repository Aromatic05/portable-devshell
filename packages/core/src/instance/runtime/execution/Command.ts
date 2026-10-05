import type { Channel, CommandResult } from "@portable-devshell/shared";

import type { WorkerCommandInteractiveSession } from "../../transport/endpoint/channel/worker/Command.js";
import type { WorkerConnection } from "../../transport/endpoint/channel/worker/index.js";
import { WorkerBinary, type WorkerCommandName } from "../Binary.js";

export type { WorkerCommandName } from "../Binary.js";

export interface WorkerCommandOptions {
    instanceName: string;
    extraArgs?: readonly string[];
    env?: NodeJS.ProcessEnv;
}

export interface WorkerChannelOptions {
    instanceName: string;
    env?: NodeJS.ProcessEnv;
    interactiveSession?: WorkerCommandInteractiveSession;
}

export type WorkerCommandResult = CommandResult;

export function runWorkerCommand(
    connection: WorkerConnection,
    executable: string,
    command: WorkerCommandName,
    options: WorkerCommandOptions,
    interactiveSession?: WorkerCommandInteractiveSession,
): Promise<WorkerCommandResult> {
    const built = new WorkerBinary(executable).buildCommand(command, options.instanceName, options.extraArgs);
    return connection.runCommand(command, [built.command, ...built.args], {
        env: options.env,
        instance: options.instanceName,
        interactiveSession,
    });
}

export interface WorkerRuntime {
    connectChannel(options: WorkerChannelOptions): Promise<Channel>;
    retireProviderResources?(): Promise<void>;
    runWorkerCommand(
        command: WorkerCommandName,
        options: WorkerCommandOptions,
        interactiveSession?: WorkerCommandInteractiveSession,
    ): Promise<WorkerCommandResult>;
    installWorker(
        interactiveSession?: WorkerCommandInteractiveSession,
    ): Promise<void>;
}

export class WorkerCommandClient {
    readonly #runtime: WorkerRuntime;
    readonly #instanceName: string;
    readonly #env?: NodeJS.ProcessEnv;

    constructor(
        runtime: WorkerRuntime,
        instanceName: string,
        env?: NodeJS.ProcessEnv,
    ) {
        this.#runtime = runtime;
        this.#instanceName = instanceName;
        this.#env = env;
    }

    start(interactiveSession?: WorkerCommandInteractiveSession): Promise<WorkerCommandResult> {
        return this.#runtime.runWorkerCommand("start", { instanceName: this.#instanceName, env: this.#env }, interactiveSession);
    }
    status(): Promise<WorkerCommandResult> {
        return this.#runtime.runWorkerCommand("status", { instanceName: this.#instanceName, env: this.#env });
    }
    stop(): Promise<WorkerCommandResult> {
        return this.#runtime.runWorkerCommand("stop", { instanceName: this.#instanceName, env: this.#env });
    }
    logs(): Promise<WorkerCommandResult> {
        return this.#runtime.runWorkerCommand("logs", { instanceName: this.#instanceName, env: this.#env });
    }
    retireRuntime(): Promise<WorkerCommandResult> {
        return this.#runtime.runWorkerCommand("retire", { instanceName: this.#instanceName, env: this.#env });
    }
    async retireProviderResources(): Promise<void> {
        await this.#runtime.retireProviderResources?.();
    }
}
