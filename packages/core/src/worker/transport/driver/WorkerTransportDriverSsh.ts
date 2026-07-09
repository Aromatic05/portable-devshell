import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ControlError, errorCodes } from "@portable-devshell/shared";
import { parseArgsStringToArgv } from "string-argv";

import { WorkerBinary } from "../../WorkerBinary.js";
import { RemoteWorkerInstaller } from "../../install/RemoteWorkerInstaller.js";
import {
    createCommandContext,
    createProviderError,
    type WorkerCommandInteractiveSession,
    type SpawnFunction,
    waitForCommandResult,
    type ProviderCommandContext,
    type WorkerCommandTransport
} from "../../command/WorkerCommandTransport.js";
import type { WorkerCommandName, WorkerCommandOptions, WorkerRpcOptions } from "../../command/WorkerCommandOptions.js";
import { createWorkerRpcProcess, type WorkerRpcProcess } from "../../WorkerProcess.js";
import {
    createWorkerTargetProbeFailedError,
    parseWorkerTargetProbeOutput,
    workerTargetProbeCommandLine
} from "../../target/WorkerTargetProbe.js";

const SSH_NON_INTERACTIVE_ARGS = [
    "-oBatchMode=yes",
    "-oNumberOfPasswordPrompts=0",
    "-oKbdInteractiveAuthentication=no",
    "-oPasswordAuthentication=no"
] as const;
const SSH_INTERACTIVE_HINT =
    "portable-devshell: ssh command requires interactive authentication or host confirmation; non-interactive control commands fail fast.";

export interface SshWorkerTransportOptions {
    command: string;
    workspace?: string;
    workerBinary?: WorkerBinary;
    spawnFunction?: SpawnFunction;
}

export class SshWorkerTransport implements WorkerCommandTransport {
    readonly #sshCommand: readonly [string, ...string[]];
    readonly #workspace?: string;
    readonly #workerBinary: WorkerBinary;
    readonly #installer: RemoteWorkerInstaller;
    readonly #spawn: SpawnFunction;
    readonly #controlPath = join(tmpdir(), `pds-ssh-${randomUUID().slice(0, 8)}`);
    #controlSocketEnabled = false;

    constructor(options: SshWorkerTransportOptions) {
        this.#sshCommand = parseSshCommand(options.command);
        this.#workspace = options.workspace;
        this.#workerBinary = options.workerBinary ?? new WorkerBinary();
        this.#spawn = options.spawnFunction ?? spawn;
        this.#installer = new RemoteWorkerInstaller({
            createContext: (operation, command) => this.#createShellContext(operation, command),
            probeTarget: () => this.#probeTarget(),
            spawnShell: (commandLine, stdio, context) => this.#spawnRemoteShell(commandLine, stdio, context),
            createProviderError: this.#createProviderError
        });
    }

    async installWorker(interactiveSession?: WorkerCommandInteractiveSession): Promise<void> {
        const installCommand = new WorkerBinary(await this.#resolveExecutable(interactiveSession)).buildInstallCommand();
        const commandLine = [installCommand.command, ...installCommand.args].map(shellEscape).join(" ");
        const context = this.#createRemoteShellContext(
            "installWorker",
            commandLine
        );
        const result = this.#decorateCommandResult(
            await waitForCommandResult(
                this.#spawnRemoteShell(commandLine, ["ignore", "pipe", "pipe"], context),
                this.#createProviderError,
                context
            )
        );

        if (result.exitCode !== 0) {
            throw this.#createProviderError(context, new Error(result.stderr || result.stdout || "worker install check failed"), {
                errorCode: errorCodes.coreWorkerProvisionFailed,
                result
            });
        }
    }

    async runWorkerCommand(
        command: WorkerCommandName,
        options: WorkerCommandOptions,
        interactiveSession?: WorkerCommandInteractiveSession
    ) {
        if (interactiveSession !== undefined) {
            await this.#ensureInteractiveControlConnection(command, options.instanceName, interactiveSession, options.env);
        }

        const workerCommand = new WorkerBinary(await this.#resolveExecutable(interactiveSession)).buildCommand(
            command,
            options.instanceName,
            options.extraArgs
        );
        const commandLine = [workerCommand.command, ...workerCommand.args].map(shellEscape).join(" ");
        const context = this.#createRemoteShellContext(
            command,
            commandLine,
            {
                instance: options.instanceName,
                useWorkspace: command === "start"
            }
        );
        const child = this.#spawnRemoteShell(commandLine, ["ignore", "pipe", "pipe"], context, options.env, command === "start");

        return this.#decorateCommandResult(await waitForCommandResult(child, this.#createProviderError, context));
    }

    async spawnWorkerRpc(options: WorkerRpcOptions): Promise<WorkerRpcProcess> {
        const workerCommand = new WorkerBinary(await this.#resolveExecutable()).buildCommand("rpc", options.instanceName);
        const commandLine = [workerCommand.command, ...workerCommand.args].map(shellEscape).join(" ");
        const context = this.#createRemoteShellContext(
            "spawnWorkerRpc",
            commandLine,
            { instance: options.instanceName }
        );
        const child = this.#spawnRemoteShell(commandLine, ["pipe", "pipe", "pipe"], context, options.env);
        return createWorkerRpcProcess(child);
    }

    async #resolveExecutable(interactiveSession?: WorkerCommandInteractiveSession): Promise<string> {
        if (interactiveSession !== undefined) {
            await this.#ensureInteractiveControlConnection("resolveExecutable", undefined, interactiveSession);
        }

        return await this.#installer.ensure(this.#workerBinary.executable);
    }

    async #probeTarget() {
        const context = this.#createRemoteShellContext("probeTarget", workerTargetProbeCommandLine);
        const child = this.#spawnRemoteShell(workerTargetProbeCommandLine, ["ignore", "pipe", "pipe"], context);

        try {
            const result = this.#decorateCommandResult(await waitForCommandResult(child, this.#createProviderError, context));

            if (result.exitCode !== 0) {
                throw createWorkerTargetProbeFailedError(context, { result });
            }

            return parseWorkerTargetProbeOutput(context, result.stdout);
        } catch (error) {
            if (error instanceof ControlError) {
                throw error;
            }

            throw createWorkerTargetProbeFailedError(context, { cause: error });
        }
    }

    #spawnRemoteShell(
        commandLine: string,
        stdio: ["ignore" | "pipe", "pipe", "pipe"],
        context: ProviderCommandContext,
        env?: NodeJS.ProcessEnv,
        useWorkspace: boolean = false
    ) {
        const command = this.#buildRemoteShellCommand(this.#withRemoteCwd(commandLine, useWorkspace));

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
        options: { cwd?: string; instance?: string; useWorkspace?: boolean } = {}
    ): ProviderCommandContext {
        const remoteCommand = this.#withRemoteCwd(commandLine, options.useWorkspace ?? false);

        return createCommandContext({
            command: this.#buildRemoteShellCommand(remoteCommand),
            cwd: options.cwd ?? (options.useWorkspace === true ? this.#workspace : undefined),
            instance: options.instance,
            operation,
            provider: "ssh"
        });
    }

    #createShellContext(operation: string, command: readonly string[]): ProviderCommandContext {
        const commandLine =
            command[0] === "sh" && command[1] === "-lc" && typeof command[2] === "string"
                ? command[2]
                : command.map(shellEscape).join(" ");
        return this.#createRemoteShellContext(operation, commandLine);
    }

    #withRemoteCwd(commandLine: string, useWorkspace: boolean): string {
        return useWorkspace && this.#workspace ? `cd ${shellEscape(this.#workspace)} && ${commandLine}` : commandLine;
    }

    #buildRemoteShellCommand(commandLine: string): [string, ...string[]] {
        return [
            this.#sshCommand[0],
            ...SSH_NON_INTERACTIVE_ARGS,
            ...(this.#controlSocketEnabled ? this.#buildControlSocketArgs() : []),
            ...this.#sshCommand.slice(1),
            "--",
            "sh",
            "-lc",
            shellEscape(commandLine)
        ];
    }

    #decorateCommandResult<T extends { details?: ProviderCommandContext | Record<string, unknown>; exitCode: number | null; stderr: string; stdout: string }>(
        result: T
    ): T {
        const stderr = this.#appendInteractiveHint(result.exitCode, result.stderr);
        if (stderr === result.stderr) {
            return result;
        }

        const details = result.details;
        if (details !== undefined && "stderrTail" in details && typeof details.stderrTail === "string") {
            details.stderrTail = stderr;
        }

        return {
            ...result,
            stderr
        };
    }

    #appendInteractiveHint(exitCode: number | null, stderr: string): string {
        if (exitCode !== 255) {
            return stderr;
        }

        const normalized = stderr.toLowerCase();
        if (
            !normalized.includes("permission denied") &&
            !normalized.includes("password") &&
            !normalized.includes("passphrase") &&
            !normalized.includes("keyboard-interactive") &&
            !normalized.includes("host key verification failed") &&
            !normalized.includes("authenticity of host")
        ) {
            return stderr;
        }

        return stderr.includes(SSH_INTERACTIVE_HINT) ? stderr : `${stderr}${stderr.endsWith("\n") || stderr.length === 0 ? "" : "\n"}${SSH_INTERACTIVE_HINT}\n`;
    }

    readonly #createProviderError = (
        context: ProviderCommandContext,
        cause: unknown,
        options?: { errorCode?: string; result?: { exitCode?: number | null; signal?: string; stderr?: string; stdout?: string } }
    ) => createProviderError(context, cause, options);

    async #ensureInteractiveControlConnection(
        operation: string,
        instance: string | undefined,
        interactiveSession: WorkerCommandInteractiveSession,
        env?: NodeJS.ProcessEnv
    ): Promise<void> {
        if (this.#controlSocketEnabled) {
            return;
        }

        const commandLine = ":";
        const context = createCommandContext({
            command: this.#buildInteractiveRemoteShellCommand(commandLine),
            cwd: this.#workspace,
            instance,
            operation,
            provider: "ssh"
        });
        const result = await this.#runInteractiveRemoteShell(commandLine, context, interactiveSession, env);

        if (result.exitCode !== 0) {
            throw this.#createProviderError(context, new Error(result.stderr || result.stdout || "ssh interactive authentication failed"), {
                result
            });
        }

        this.#controlSocketEnabled = true;
    }

    #buildControlSocketArgs(): string[] {
        return [`-oControlPath=${this.#controlPath}`, "-oControlMaster=auto", "-oControlPersist=600"];
    }

    #buildInteractiveRemoteShellCommand(commandLine: string): [string, ...string[]] {
        const sshCommand = [
            this.#sshCommand[0],
            ...this.#buildControlSocketArgs(),
            ...this.#sshCommand.slice(1),
            "--",
            "sh",
            "-lc",
            this.#withRemoteCwd(commandLine, true)
        ];

        return ["script", "-qefc", sshCommand.map(shellEscape).join(" "), "/dev/null"];
    }

    async #runInteractiveRemoteShell(
        commandLine: string,
        context: ProviderCommandContext,
        interactiveSession: WorkerCommandInteractiveSession,
        env?: NodeJS.ProcessEnv
    ) {
        const command = this.#buildInteractiveRemoteShellCommand(commandLine);
        let child;

        try {
            child = this.#spawn(command[0], command.slice(1), {
                env,
                stdio: ["pipe", "pipe", "pipe"]
            });
        } catch (error) {
            throw this.#createProviderError(context, error);
        }

        let outputFlush = Promise.resolve();
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
            outputFlush = outputFlush.then(async () => {
                await interactiveSession.writeOutput(chunk);
            });
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            outputFlush = outputFlush.then(async () => {
                await interactiveSession.writeOutput(chunk);
            });
        });

        const exitSignal = once(child, "close").then(() => undefined);
        const inputPump = this.#pumpInteractiveInput(child.stdin, interactiveSession, exitSignal);
        const result = await waitForCommandResult(child, this.#createProviderError, context);

        await inputPump;
        await outputFlush;

        return result;
    }

    async #pumpInteractiveInput(
        stdin: NodeJS.WritableStream | null,
        interactiveSession: WorkerCommandInteractiveSession,
        exitSignal: Promise<undefined>
    ): Promise<void> {
        if (stdin === null) {
            return;
        }

        for (;;) {
            const chunk = await Promise.race([interactiveSession.readInput(), exitSignal]);
            if (chunk === undefined) {
                stdin.end();
                return;
            }

            if (stdin.write(chunk)) {
                continue;
            }

            await once(stdin, "drain");
        }
    }
}

function parseSshCommand(command: string): [string, ...string[]] {
    const parsed = parseArgsStringToArgv(command).filter((entry) => entry.length > 0);
    if (parsed.length === 0) {
        throw new Error("ssh.command must not be empty");
    }

    return [parsed[0], ...parsed.slice(1)];
}

function shellEscape(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
