import { spawn } from "node:child_process";

import { WorkerBinary } from "../../WorkerBinary.js";
import {
    createProviderError,
    type SpawnFunction,
    waitForCommandResult,
    type WorkerCommandTransport
} from "../../command/WorkerCommandTransport.js";
import type { WorkerCommandName, WorkerCommandOptions, WorkerRpcOptions } from "../../command/WorkerCommandOptions.js";
import { createWorkerRpcProcess, type WorkerRpcProcess } from "../../WorkerProcess.js";

export interface SshWorkerTransportOptions {
    host: string;
    remoteCwd?: string;
    sshBinary?: string;
    workerBinary?: WorkerBinary;
    spawnFunction?: SpawnFunction;
}

export class SshWorkerTransport implements WorkerCommandTransport {
    readonly #host: string;
    readonly #remoteCwd?: string;
    readonly #sshBinary: string;
    readonly #workerBinary: WorkerBinary;
    readonly #spawn: SpawnFunction;

    constructor(options: SshWorkerTransportOptions) {
        this.#host = options.host;
        this.#remoteCwd = options.remoteCwd;
        this.#sshBinary = options.sshBinary ?? "ssh";
        this.#workerBinary = options.workerBinary ?? new WorkerBinary();
        this.#spawn = options.spawnFunction ?? spawn;
    }

    async installWorker(): Promise<void> {
        const installCommand = this.#workerBinary.buildInstallCommand();
        const child = this.#spawnRemoteShell(
            [installCommand.command, ...installCommand.args].map(shellEscape).join(" "),
            ["ignore", "pipe", "pipe"]
        );
        const result = await waitForCommandResult(child, this.#createProviderError, "installWorker");

        if (result.exitCode !== 0) {
            throw this.#createProviderError("installWorker", new Error(result.stderr || result.stdout || "worker install check failed"));
        }
    }

    async runWorkerCommand(command: WorkerCommandName, options: WorkerCommandOptions) {
        const workerCommand = this.#workerBinary.buildCommand(command, options.instanceName, options.extraArgs);
        const child = this.#spawnRemoteShell(
            [workerCommand.command, ...workerCommand.args].map(shellEscape).join(" "),
            ["ignore", "pipe", "pipe"],
            options.env
        );

        return await waitForCommandResult(child, this.#createProviderError, "runWorkerCommand");
    }

    async spawnWorkerRpc(options: WorkerRpcOptions): Promise<WorkerRpcProcess> {
        const workerCommand = this.#workerBinary.buildCommand("rpc", options.instanceName);
        const child = this.#spawnRemoteShell(
            [workerCommand.command, ...workerCommand.args].map(shellEscape).join(" "),
            ["pipe", "pipe", "pipe"],
            options.env
        );
        return createWorkerRpcProcess(child);
    }

    #spawnRemoteShell(commandLine: string, stdio: ["ignore" | "pipe", "pipe", "pipe"], env?: NodeJS.ProcessEnv) {
        const remoteCommand = this.#remoteCwd ? `cd ${shellEscape(this.#remoteCwd)} && ${commandLine}` : commandLine;

        try {
            return this.#spawn(this.#sshBinary, [this.#host, "--", "sh", "-lc", remoteCommand], {
                env,
                stdio
            });
        } catch (error) {
            throw this.#createProviderError("spawnRemoteShell", error);
        }
    }

    readonly #createProviderError = (operation: string, cause: unknown): Error =>
        createProviderError("ssh", operation, cause, { host: this.#host });
}

function shellEscape(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
