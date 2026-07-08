import { spawn } from "node:child_process";

import { errorCodes } from "@portable-devshell/shared";

import { WorkerBinary } from "../../WorkerBinary.js";
import { RemoteWorkerInstaller } from "../../install/RemoteWorkerInstaller.js";
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

export interface PodmanWorkerTransportOptions {
    container: string;
    podmanBinary?: string;
    remoteCwd?: string;
    workerBinary?: WorkerBinary;
    spawnFunction?: SpawnFunction;
}

export class PodmanWorkerTransport implements WorkerCommandTransport {
    readonly #container: string;
    readonly #podmanBinary: string;
    readonly #remoteCwd?: string;
    readonly #workerBinary: WorkerBinary;
    readonly #installer: RemoteWorkerInstaller;
    readonly #spawn: SpawnFunction;

    constructor(options: PodmanWorkerTransportOptions) {
        this.#container = options.container;
        this.#podmanBinary = options.podmanBinary ?? "podman";
        this.#remoteCwd = options.remoteCwd;
        this.#workerBinary = options.workerBinary ?? new WorkerBinary();
        this.#spawn = options.spawnFunction ?? spawn;
        this.#installer = new RemoteWorkerInstaller({
            createContext: (operation, command) => this.#createShellContext(operation, command),
            spawnShell: (commandLine, stdio, context) => this.#spawnShell(commandLine, stdio, context),
            createProviderError: this.#createProviderError
        });
    }

    async installWorker(): Promise<void> {
        const installCommand = new WorkerBinary(await this.#resolveExecutable()).buildInstallCommand();
        const context = this.#createExecContext("installWorker", [installCommand.command, ...installCommand.args]);
        const child = this.#spawnExec(context, ["ignore", "pipe", "pipe"]);
        const result = await waitForCommandResult(child, this.#createProviderError, context);

        if (result.exitCode !== 0) {
            throw this.#createProviderError(context, new Error(result.stderr || result.stdout || "worker install check failed"), {
                errorCode: errorCodes.coreWorkerProvisionFailed,
                result
            });
        }
    }

    async runWorkerCommand(command: WorkerCommandName, options: WorkerCommandOptions) {
        const workerCommand = new WorkerBinary(await this.#resolveExecutable()).buildCommand(
            command,
            options.instanceName,
            options.extraArgs
        );
        const context = this.#createExecContext(command, [workerCommand.command, ...workerCommand.args], {
            instance: options.instanceName
        });
        const child = this.#spawnExec(context, ["ignore", "pipe", "pipe"], options.env);

        return await waitForCommandResult(child, this.#createProviderError, context);
    }

    async spawnWorkerRpc(options: WorkerRpcOptions): Promise<WorkerRpcProcess> {
        const workerCommand = new WorkerBinary(await this.#resolveExecutable()).buildCommand("rpc", options.instanceName);
        const context = this.#createExecContext("spawnWorkerRpc", [workerCommand.command, ...workerCommand.args], {
            instance: options.instanceName
        });
        return createWorkerRpcProcess(this.#spawnExec(context, ["pipe", "pipe", "pipe"], options.env, errorCodes.coreWorkerRpcSpawnFailed));
    }

    async #resolveExecutable(): Promise<string> {
        return await this.#installer.ensure(this.#workerBinary.executable);
    }

    #spawnExec(
        context: ProviderCommandContext,
        stdio: ["ignore" | "pipe", "pipe", "pipe"],
        env?: NodeJS.ProcessEnv,
        errorCode: string = errorCodes.coreProviderFailed
    ) {
        const execArgs = ["exec", ...this.#workingDirectoryArgs(), "-i", this.#container, ...context.command];

        try {
            return this.#spawn(this.#podmanBinary, execArgs, {
                env,
                stdio
            });
        } catch (error) {
            throw this.#createProviderError(context, error, { errorCode });
        }
    }

    #spawnShell(commandLine: string, stdio: ["ignore" | "pipe", "pipe", "pipe"], context: ProviderCommandContext) {
        try {
            return this.#spawn(this.#podmanBinary, ["exec", "-i", this.#container, "sh", "-lc", commandLine], {
                stdio
            });
        } catch (error) {
            throw this.#createProviderError(context, error);
        }
    }

    #workingDirectoryArgs(): string[] {
        return this.#remoteCwd ? ["-w", this.#remoteCwd] : [];
    }

    #createExecContext(operation: string, command: readonly string[], options: { instance?: string } = {}): ProviderCommandContext {
        return createCommandContext({
            command,
            cwd: this.#remoteCwd,
            instance: options.instance,
            operation,
            provider: "podman"
        });
    }

    #createShellContext(operation: string, command: readonly string[]): ProviderCommandContext {
        return createCommandContext({
            command: [this.#podmanBinary, "exec", "-i", this.#container, ...command],
            instance: undefined,
            operation,
            provider: "podman"
        });
    }

    readonly #createProviderError = (
        context: ProviderCommandContext,
        cause: unknown,
        options?: { errorCode?: string; result?: { exitCode?: number | null; signal?: string; stderr?: string; stdout?: string } }
    ) => createProviderError(context, cause, options);
}
