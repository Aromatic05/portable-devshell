import { spawn } from "node:child_process";

import { WorkerBinary } from "../command/WorkerBinary.js";
import {
    createProviderError,
    type SpawnFunction,
    waitForCommandResult,
    type WorkerCommandTransport
} from "../command/WorkerCommandTransport.js";
import type { WorkerCommandName, WorkerCommandOptions, WorkerRpcOptions } from "../command/WorkerCommandOptions.js";
import { createWorkerRpcProcess, type WorkerRpcProcess } from "../process/WorkerProcess.js";

export interface LocalWorkerTransportOptions {
    workerBinary?: WorkerBinary;
    spawnFunction?: SpawnFunction;
}

export class LocalWorkerTransport implements WorkerCommandTransport {
    readonly #workerBinary: WorkerBinary;
    readonly #spawn: SpawnFunction;

    constructor(options: LocalWorkerTransportOptions = {}) {
        this.#workerBinary = options.workerBinary ?? new WorkerBinary();
        this.#spawn = options.spawnFunction ?? spawn;
    }

    async installWorker(): Promise<void> {
        const installCommand = this.#workerBinary.buildInstallCommand();
        const child = this.#spawnCommand(installCommand.command, installCommand.args, {
            stdio: ["ignore", "pipe", "pipe"]
        });

        const result = await waitForCommandResult(child, this.#createProviderError, "installWorker");
        if (result.exitCode !== 0) {
            throw this.#createProviderError("installWorker", new Error(result.stderr || result.stdout || "worker install check failed"));
        }
    }

    async runWorkerCommand(command: WorkerCommandName, options: WorkerCommandOptions) {
        const workerCommand = this.#workerBinary.buildCommand(command, options.instanceName, options.extraArgs);
        const child = this.#spawnCommand(workerCommand.command, workerCommand.args, {
            cwd: command === "start" ? options.workspacePath : undefined,
            env: options.env,
            stdio: ["ignore", "pipe", "pipe"]
        });

        return await waitForCommandResult(child, this.#createProviderError, "runWorkerCommand");
    }

    async spawnWorkerRpc(options: WorkerRpcOptions): Promise<WorkerRpcProcess> {
        const command = this.#workerBinary.buildCommand("rpc", options.instanceName);
        const child = this.#spawnCommand(command.command, command.args, {
            env: options.env,
            stdio: ["pipe", "pipe", "pipe"]
        });
        return createWorkerRpcProcess(child);
    }

    #spawnCommand(command: string, args: readonly string[], options: Parameters<SpawnFunction>[2]) {
        try {
            return this.#spawn(command, args, options);
        } catch (error) {
            throw this.#createProviderError("spawnCommand", error);
        }
    }

    readonly #createProviderError = (operation: string, cause: unknown): Error =>
        createProviderError("local", operation, cause, {});
}
