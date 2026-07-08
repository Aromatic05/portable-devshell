import { spawn } from "node:child_process";

import { WorkerAssetResolver } from "../../WorkerAssetResolver.js";
import { WorkerBinary } from "../../WorkerBinary.js";
import {
    createProviderError,
    type SpawnFunction,
    waitForCommandResult,
    type WorkerCommandTransport
} from "../../command/WorkerCommandTransport.js";
import type { WorkerCommandName, WorkerCommandOptions, WorkerRpcOptions } from "../../command/WorkerCommandOptions.js";
import { createWorkerRpcProcess, type WorkerRpcProcess } from "../../WorkerProcess.js";
import { LocalWorkerInstaller } from "../../install/LocalWorkerInstaller.js";

export interface LocalWorkerTransportOptions {
    installer?: LocalWorkerInstaller;
    resolver?: WorkerAssetResolver;
    workerBinary?: WorkerBinary;
    spawnFunction?: SpawnFunction;
}

export class LocalWorkerTransport implements WorkerCommandTransport {
    readonly #installer: LocalWorkerInstaller;
    readonly #resolver: WorkerAssetResolver;
    readonly #workerBinary: WorkerBinary;
    readonly #spawn: SpawnFunction;

    constructor(options: LocalWorkerTransportOptions = {}) {
        this.#installer = options.installer ?? new LocalWorkerInstaller();
        this.#resolver = options.resolver ?? new WorkerAssetResolver();
        this.#workerBinary = options.workerBinary ?? new WorkerBinary();
        this.#spawn = options.spawnFunction ?? spawn;
    }

    async installWorker(): Promise<void> {
        const installCommand = new WorkerBinary(await this.#resolveExecutable()).buildInstallCommand();
        const child = this.#spawnCommand(installCommand.command, installCommand.args, {
            stdio: ["ignore", "pipe", "pipe"]
        });

        const result = await waitForCommandResult(child, this.#createProviderError, "installWorker");
        if (result.exitCode !== 0) {
            throw this.#createProviderError("installWorker", new Error(result.stderr || result.stdout || "worker install check failed"));
        }
    }

    async runWorkerCommand(command: WorkerCommandName, options: WorkerCommandOptions) {
        const workerCommand = new WorkerBinary(await this.#resolveExecutable(options.env)).buildCommand(
            command,
            options.instanceName,
            options.extraArgs
        );
        const child = this.#spawnCommand(workerCommand.command, workerCommand.args, {
            cwd: command === "start" ? options.workspacePath : undefined,
            env: this.#mergeEnv(options.env),
            stdio: ["ignore", "pipe", "pipe"]
        });

        return await waitForCommandResult(child, this.#createProviderError, "runWorkerCommand");
    }

    async spawnWorkerRpc(options: WorkerRpcOptions): Promise<WorkerRpcProcess> {
        const command = new WorkerBinary(await this.#resolveExecutable(options.env)).buildCommand("rpc", options.instanceName);
        const child = this.#spawnCommand(command.command, command.args, {
            env: this.#mergeEnv(options.env),
            stdio: ["pipe", "pipe", "pipe"]
        });
        return createWorkerRpcProcess(child);
    }

    async #resolveExecutable(env?: NodeJS.ProcessEnv): Promise<string> {
        if (this.#workerBinary.executable !== "devshell-worker") {
            return this.#workerBinary.executable;
        }

        const homeDirectory = env?.HOME ?? process.env.HOME;

        if (homeDirectory === undefined || homeDirectory.length === 0) {
            throw this.#createProviderError("resolveExecutable", new Error("HOME is required to install the local worker"));
        }

        const asset = await this.#resolver.resolve().catch((error) => {
            throw this.#createProviderError("resolveExecutable", error);
        });

        return await this.#installer.ensure(homeDirectory, asset).catch((error) => {
            throw this.#createProviderError("resolveExecutable", error);
        });
    }

    #mergeEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
        return {
            ...process.env,
            ...env
        };
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
