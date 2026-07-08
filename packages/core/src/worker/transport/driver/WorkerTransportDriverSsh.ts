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
    readonly #installer: RemoteWorkerInstaller;
    readonly #spawn: SpawnFunction;

    constructor(options: SshWorkerTransportOptions) {
        this.#host = options.host;
        this.#remoteCwd = options.remoteCwd;
        this.#sshBinary = options.sshBinary ?? "ssh";
        this.#workerBinary = options.workerBinary ?? new WorkerBinary();
        this.#spawn = options.spawnFunction ?? spawn;
        this.#installer = new RemoteWorkerInstaller({
            createContext: (operation, command) => this.#createShellContext(operation, command),
            spawnShell: (commandLine, stdio, context) => this.#spawnRemoteShell(commandLine, stdio, context),
            createProviderError: this.#createProviderError
        });
    }

    async installWorker(): Promise<void> {
        const installCommand = new WorkerBinary(await this.#resolveExecutable()).buildInstallCommand();
        const context = this.#createRemoteShellContext(
            "installWorker",
            [installCommand.command, ...installCommand.args].map(shellEscape).join(" ")
        );
        const result = await waitForCommandResult(
            this.#spawnRemoteShell(context.command[5] as string, ["ignore", "pipe", "pipe"], context),
            this.#createProviderError,
            context
        );

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
        const context = this.#createRemoteShellContext(
            command,
            [workerCommand.command, ...workerCommand.args].map(shellEscape).join(" "),
            {
                instance: options.instanceName
            }
        );
        const child = this.#spawnRemoteShell(context.command[5] as string, ["ignore", "pipe", "pipe"], context, options.env);

        return await waitForCommandResult(child, this.#createProviderError, context);
    }

    async spawnWorkerRpc(options: WorkerRpcOptions): Promise<WorkerRpcProcess> {
        const workerCommand = new WorkerBinary(await this.#resolveExecutable()).buildCommand("rpc", options.instanceName);
        const context = this.#createRemoteShellContext(
            "spawnWorkerRpc",
            [workerCommand.command, ...workerCommand.args].map(shellEscape).join(" "),
            { instance: options.instanceName }
        );
        const child = this.#spawnRemoteShell(context.command[5] as string, ["pipe", "pipe", "pipe"], context, options.env);
        return createWorkerRpcProcess(child);
    }

    async #resolveExecutable(): Promise<string> {
        return await this.#installer.ensure(this.#workerBinary.executable);
    }

    #spawnRemoteShell(
        commandLine: string,
        stdio: ["ignore" | "pipe", "pipe", "pipe"],
        context: ProviderCommandContext,
        env?: NodeJS.ProcessEnv
    ) {
        const command = [this.#sshBinary, this.#host, "--", "sh", "-lc", commandLine];

        try {
            return this.#spawn(command[0], command.slice(1), {
                env,
                stdio
            });
        } catch (error) {
            throw this.#createProviderError(context, error, {
                errorCode: context.operation === "spawnWorkerRpc" ? errorCodes.coreWorkerRpcSpawnFailed : errorCodes.coreProviderFailed
            });
        }
    }

    #createRemoteShellContext(
        operation: string,
        commandLine: string,
        options: { instance?: string } = {}
    ): ProviderCommandContext {
        const remoteCommand = this.#withRemoteCwd(commandLine);

        return createCommandContext({
            command: [this.#sshBinary, this.#host, "--", "sh", "-lc", remoteCommand],
            cwd: this.#remoteCwd,
            instance: options.instance,
            operation,
            provider: "ssh"
        });
    }

    #createShellContext(operation: string, command: readonly string[]): ProviderCommandContext {
        const remoteCommand =
            command[0] === "sh" && command[1] === "-lc" && typeof command[2] === "string"
                ? this.#withRemoteCwd(command[2])
                : undefined;

        return createCommandContext({
            command:
                remoteCommand === undefined
                    ? [this.#sshBinary, this.#host, "--", ...command]
                    : [this.#sshBinary, this.#host, "--", "sh", "-lc", remoteCommand],
            cwd: this.#remoteCwd,
            operation,
            provider: "ssh"
        });
    }

    #withRemoteCwd(commandLine: string): string {
        return this.#remoteCwd ? `cd ${shellEscape(this.#remoteCwd)} && ${commandLine}` : commandLine;
    }

    readonly #createProviderError = (
        context: ProviderCommandContext,
        cause: unknown,
        options?: { errorCode?: string; result?: { exitCode?: number | null; signal?: string; stderr?: string; stdout?: string } }
    ) => createProviderError(context, cause, options);
}

function shellEscape(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
