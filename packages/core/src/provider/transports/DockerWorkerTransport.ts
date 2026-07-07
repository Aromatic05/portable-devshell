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

export interface DockerWorkerTransportOptions {
    container: string;
    dockerBinary?: string;
    remoteCwd?: string;
    workerBinary?: WorkerBinary;
    spawnFunction?: SpawnFunction;
}

export class DockerWorkerTransport implements WorkerCommandTransport {
    readonly #container: string;
    readonly #dockerBinary: string;
    readonly #remoteCwd?: string;
    readonly #workerBinary: WorkerBinary;
    readonly #spawn: SpawnFunction;

    constructor(options: DockerWorkerTransportOptions) {
        this.#container = options.container;
        this.#dockerBinary = options.dockerBinary ?? "docker";
        this.#remoteCwd = options.remoteCwd;
        this.#workerBinary = options.workerBinary ?? new WorkerBinary();
        this.#spawn = options.spawnFunction ?? spawn;
    }

    async installWorker(): Promise<void> {
        const installCommand = this.#workerBinary.buildInstallCommand();
        const child = this.#spawnExec(installCommand.command, installCommand.args, ["ignore", "pipe", "pipe"]);
        const result = await waitForCommandResult(child, this.#createProviderError, "installWorker");

        if (result.exitCode !== 0) {
            throw this.#createProviderError("installWorker", new Error(result.stderr || result.stdout || "worker install check failed"));
        }
    }

    async runWorkerCommand(command: WorkerCommandName, options: WorkerCommandOptions) {
        const workerCommand = this.#workerBinary.buildCommand(command, options.instanceName, options.extraArgs);
        const child = this.#spawnExec(workerCommand.command, workerCommand.args, ["ignore", "pipe", "pipe"], options.env);

        return await waitForCommandResult(child, this.#createProviderError, "runWorkerCommand");
    }

    async spawnWorkerRpc(options: WorkerRpcOptions): Promise<WorkerRpcProcess> {
        const workerCommand = this.#workerBinary.buildCommand("rpc", options.instanceName);
        return createWorkerRpcProcess(this.#spawnExec(workerCommand.command, workerCommand.args, ["pipe", "pipe", "pipe"], options.env));
    }

    #spawnExec(command: string, args: readonly string[], stdio: ["ignore" | "pipe", "pipe", "pipe"], env?: NodeJS.ProcessEnv) {
        const execArgs = ["exec", ...this.#workingDirectoryArgs(), "-i", this.#container, command, ...args];

        try {
            return this.#spawn(this.#dockerBinary, execArgs, {
                env,
                stdio
            });
        } catch (error) {
            throw this.#createProviderError("spawnExec", error);
        }
    }

    #workingDirectoryArgs(): string[] {
        return this.#remoteCwd ? ["-w", this.#remoteCwd] : [];
    }

    readonly #createProviderError = (operation: string, cause: unknown): Error =>
        createProviderError("docker", operation, cause, { container: this.#container });
}
