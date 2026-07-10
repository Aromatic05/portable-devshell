import { spawn } from "node:child_process";

import { ControlError, errorCodes } from "@portable-devshell/shared";

import { WorkerAssetResolver } from "../../WorkerAssetResolver.js";
import { WorkerBinary } from "../../WorkerBinary.js";
import {
    createCommandContext,
    createProviderError,
    type SpawnFunction,
    waitForCommandResult,
    type ProviderCommandContext,
    type WorkerCommandTransport
} from "../../command/WorkerCommandTransport.js";
import type { WorkerCommandName, WorkerCommandOptions, WorkerRpcOptions } from "../../command/WorkerCommandOptions.js";
import { createWorkerRpcProcess, type WorkerRpcProcess } from "../../WorkerProcess.js";
import { LocalWorkerInstaller } from "../../install/LocalWorkerInstaller.js";
import { probeLocalWorkerTarget } from "../../target/WorkerTargetProbe.js";

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
        const context = this.#createCommandContext("installWorker", [installCommand.command, ...installCommand.args]);
        const child = this.#spawnCommand(context, {
            env: this.#mergeEnv(undefined),
            stdio: ["ignore", "pipe", "pipe"]
        });

        const result = await waitForCommandResult(child, this.#createProviderError, context);
        if (result.exitCode !== 0) {
            throw this.#createProviderError(context, new Error(result.stderr || result.stdout || "worker install check failed"), {
                errorCode: errorCodes.coreWorkerProvisionFailed,
                result
            });
        }
    }

    async runWorkerCommand(command: WorkerCommandName, options: WorkerCommandOptions) {
        const workerCommand = new WorkerBinary(await this.#resolveExecutable(options.env)).buildCommand(
            command,
            options.instanceName,
            options.extraArgs
        );
        const context = this.#createCommandContext(command, [workerCommand.command, ...workerCommand.args], {
            cwd: command === "start" ? options.workspacePath : undefined,
            instance: options.instanceName
        });
        const child = this.#spawnCommand(context, {
            cwd: context.cwd,
            env: this.#mergeEnv(options.env),
            stdio: ["ignore", "pipe", "pipe"]
        });

        return await waitForCommandResult(child, this.#createProviderError, context);
    }

    async spawnWorkerRpc(options: WorkerRpcOptions): Promise<WorkerRpcProcess> {
        const workerCommand = new WorkerBinary(await this.#resolveExecutable(options.env)).buildCommand("rpc", options.instanceName);
        const context = this.#createCommandContext("spawnWorkerRpc", [workerCommand.command, ...workerCommand.args], {
            instance: options.instanceName
        });
        const child = this.#spawnCommand(
            context,
            {
                env: this.#mergeEnv(options.env),
                stdio: ["pipe", "pipe", "pipe"]
            },
            errorCodes.coreWorkerRpcSpawnFailed
        );
        return createWorkerRpcProcess(child);
    }

    async #resolveExecutable(env?: NodeJS.ProcessEnv): Promise<string> {
        if (this.#workerBinary.executable !== "devshell-worker") {
            return this.#workerBinary.executable;
        }

        const homeDirectory = env?.HOME ?? process.env.HOME;

        if (homeDirectory === undefined || homeDirectory.length === 0) {
            throw this.#createProviderError(
                this.#createCommandContext("resolveExecutable", ["devshell-worker"]),
                new Error("HOME is required to install the local worker")
            );
        }

        const target = probeLocalWorkerTarget("local", "resolveExecutable");
        const asset = await this.#resolver.resolve(target).catch((error) => {
            if (error instanceof ControlError) {
                throw error;
            }

            throw this.#createProviderError(this.#createCommandContext("resolveExecutable", ["devshell-worker"]), error);
        });

        return await this.#installer.ensure(homeDirectory, asset, target).catch((error) => {
            throw this.#createProviderError(this.#createCommandContext("resolveExecutable", ["devshell-worker"]), error, {
                errorCode: errorCodes.coreWorkerProvisionFailed
            });
        });
    }

    #mergeEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
        const merged = {
            ...process.env,
            ...env
        };
        delete merged.DEVSHELL_WORKER_INTERNAL_INSTANCE;
        delete merged.DEVSHELL_WORKER_INTERNAL_WORKSPACE;
        delete merged.DEVSHELL_WORKER_INTERNAL_SECURITY_MODE;
        return merged;
    }

    #spawnCommand(
        context: ProviderCommandContext,
        options: Parameters<SpawnFunction>[2],
        errorCode: string = errorCodes.coreProviderFailed
    ) {
        const [command, ...args] = context.command;

        try {
            return this.#spawn(command, args, options);
        } catch (error) {
            throw this.#createProviderError(context, error, { errorCode });
        }
    }

    #createCommandContext(
        operation: string,
        command: readonly string[],
        options: { cwd?: string; instance?: string } = {}
    ): ProviderCommandContext {
        return createCommandContext({
            command,
            cwd: options.cwd,
            instance: options.instance,
            operation,
            provider: "local"
        });
    }

    readonly #createProviderError = (
        context: ProviderCommandContext,
        cause: unknown,
        options?: { errorCode?: string; result?: { exitCode?: number | null; signal?: string; stderr?: string; stdout?: string } }
    ) => createProviderError(context, cause, options);
}
