import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ControlError, createError, errorCodes } from "@portable-devshell/shared";
import { parseArgsStringToArgv } from "string-argv";

import { WorkerBinary } from "../../WorkerBinary.js";
import { WorkerInstallerRemote } from "../../install/WorkerInstallerRemote.js";
import {
    createCommandContext,
    type WorkerCommandInteractiveSession,
    type SpawnFunction,
    type ProviderCommandContext,
    type WorkerCommandTransport
} from "../../command/WorkerCommandTransport.js";
import type { WorkerCommandName, WorkerCommandOptions, WorkerRpcOptions } from "../../command/WorkerCommandOptions.js";
import { createWorkerRpcProcess, type WorkerRpcProcess } from "../../rpc/WorkerRpcProcess.js";
import {
    createWorkerTargetProbeFailedError,
    parseWorkerTargetProbeOutput,
    workerTargetProbeCommandLine
} from "../../target/WorkerTargetProbe.js";
import { WorkerTransportProcessRunner } from "../process/WorkerTransportProcessRunner.js";

const SSH_NON_INTERACTIVE_ARGS = [
    "-oBatchMode=yes",
    "-oNumberOfPasswordPrompts=0",
    "-oKbdInteractiveAuthentication=no",
    "-oPasswordAuthentication=no"
] as const;
const SSH_INTERACTIVE_HINT =
    "portable-devshell: ssh command requires interactive authentication or host confirmation; non-interactive control commands fail fast.";

export interface WorkerTransportDriverSshOptions {
    command: string;
    skillsDirectory?: string;
    workerBinary?: WorkerBinary;
    spawnFunction?: SpawnFunction;
}

export class WorkerTransportDriverSsh implements WorkerCommandTransport {
    readonly #sshCommand: readonly [string, ...string[]];
    readonly #workerBinary: WorkerBinary;
    readonly #installer: WorkerInstallerRemote;
    readonly #process: WorkerTransportProcessRunner;
    readonly #controlPath = join(tmpdir(), `pds-ssh-${randomUUID().slice(0, 8)}`);
    #controlSocketEnabled = false;

    constructor(options: WorkerTransportDriverSshOptions) {
        this.#sshCommand = parseSshCommand(options.command);
        this.#workerBinary = options.workerBinary ?? new WorkerBinary();
        this.#process = new WorkerTransportProcessRunner(options.spawnFunction);
        this.#installer = new WorkerInstallerRemote({
            createContext: (operation, command) => this.#createShellContext(operation, command),
            probeTarget: () => this.#probeTarget(),
            spawnShell: (commandLine, stdio, context) => this.#spawnRemoteShell(commandLine, stdio, context),
            createProviderError: this.#process.createError,
            skillsDirectory: options.skillsDirectory
        });
    }

    async installWorker(interactiveSession?: WorkerCommandInteractiveSession): Promise<void> {
        const installCommand = new WorkerBinary(await this.#resolveExecutable(interactiveSession)).buildInstallCommand();
        await this.#installer.syncSkills();
        const commandLine = [installCommand.command, ...installCommand.args].map(shellEscape).join(" ");
        const context = this.#createRemoteShellContext(
            "installWorker",
            commandLine
        );
        const result = this.#decorateCommandResult(
            await this.#process.wait(
                this.#spawnRemoteShell(commandLine, ["ignore", "pipe", "pipe"], context),
                context
            )
        );

        if (result.exitCode !== 0) {
            throw this.#process.createError(context, new Error(result.stderr || result.stdout || "worker install check failed"), {
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
            await this.#ensureInteractiveControlConnection(command, options.instanceName, interactiveSession);
        }

        const executable = await this.#resolveExecutable(interactiveSession);
        if (command === "start") {
            await this.#installer.syncSkills();
        }
        const workerCommand = new WorkerBinary(executable).buildCommand(
            command,
            options.instanceName,
            options.extraArgs
        );
        const commandLine = [workerCommand.command, ...workerCommand.args].map(shellEscape).join(" ");
        const environmentFile = await this.#prepareRemoteEnvironment(options.env);
        const remoteCommandLine = this.#withRemoteEnvironment(commandLine, environmentFile);
        const context = this.#createRemoteShellContext(
            command,
            remoteCommandLine,
            {
                instance: options.instanceName
            }
        );
        let child;
        try {
            child = this.#spawnRemoteShell(remoteCommandLine, ["ignore", "pipe", "pipe"], context);
        } catch (error) {
            await this.#removeRemoteEnvironmentFile(environmentFile).catch(() => undefined);
            throw error;
        }
        try {
            const result = this.#decorateCommandResult(await this.#process.wait(child, context));
            if (result.exitCode !== 0) {
                await this.#removeRemoteEnvironmentFile(environmentFile).catch(() => undefined);
            }
            return result;
        } catch (error) {
            await this.#removeRemoteEnvironmentFile(environmentFile).catch(() => undefined);
            throw error;
        }
    }

    async spawnWorkerRpc(options: WorkerRpcOptions): Promise<WorkerRpcProcess> {
        const executable = await this.#resolveExecutable();
        await this.#installer.syncSkills();
        const workerCommand = new WorkerBinary(executable).buildCommand("rpc", options.instanceName);
        const commandLine = [workerCommand.command, ...workerCommand.args].map(shellEscape).join(" ");
        const environmentFile = await this.#prepareRemoteEnvironment(options.env);
        const remoteCommandLine = this.#withRemoteEnvironment(commandLine, environmentFile);
        const context = this.#createRemoteShellContext(
            "spawnWorkerRpc",
            remoteCommandLine,
            { instance: options.instanceName }
        );
        let child;
        try {
            child = this.#spawnRemoteShell(remoteCommandLine, ["pipe", "pipe", "pipe"], context);
        } catch (error) {
            await this.#removeRemoteEnvironmentFile(environmentFile).catch(() => undefined);
            throw error;
        }
        const rpcProcess = createWorkerRpcProcess(child);
        return {
            ...rpcProcess,
            exit: rpcProcess.exit.finally(async () => {
                await this.#removeRemoteEnvironmentFile(environmentFile);
            })
        };
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
            const result = this.#decorateCommandResult(await this.#process.wait(child, context));

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
        _commandLine: string,
        stdio: ["ignore" | "pipe", "pipe", "pipe"],
        context: ProviderCommandContext
    ) {
        return this.#process.spawn(
            context,
            { stdio },
            context.operation === "spawnWorkerRpc" ? errorCodes.coreWorkerRpcSpawnFailed : errorCodes.coreProviderFailed
        );
    }

    async #prepareRemoteEnvironment(env: NodeJS.ProcessEnv | undefined): Promise<string | undefined> {
        const entries = Object.entries(env ?? {})
            .filter((entry): entry is [string, string] =>
                entry[1] !== undefined && !isInternalWorkerEnvironmentKey(entry[0])
            )
            .sort(([left], [right]) => left.localeCompare(right));
        if (entries.length === 0) {
            return undefined;
        }
        for (const [key, value] of entries) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || value.includes("\0")) {
                throw createError({
                    code: errorCodes.coreProviderFailed,
                    details: { environmentKey: key, provider: "ssh" },
                    message: `SSH instance environment key ${key} cannot be represented safely.`,
                    retryable: false
                });
            }
        }

        const environmentFile = `/tmp/portable-devshell-env-${randomUUID()}.sh`;
        const commandLine = `umask 077; cat > ${shellEscape(environmentFile)}`;
        const context = this.#createRemoteShellContext("prepareEnvironment", commandLine);
        const child = this.#spawnRemoteShell(commandLine, ["pipe", "pipe", "pipe"], context);
        if (child.stdin === null) {
            child.kill();
            throw this.#process.createError(context, new Error("ssh environment upload stdin is unavailable"));
        }
        const contents = `${entries.map(([key, value]) => `${key}=${shellEscape(value)}`).join("\n")}\n`;
        try {
            await new Promise<void>((resolve, reject) => {
                const onError = (error: Error) => reject(error);
                child.stdin!.once("error", onError);
                child.stdin!.end(contents, () => {
                    child.stdin!.off("error", onError);
                    resolve();
                });
            });
        } catch (error) {
            child.kill();
            throw this.#process.createError(context, error);
        }
        const result = this.#decorateCommandResult(await this.#process.wait(child, context));
        if (result.exitCode !== 0) {
            throw this.#process.createError(
                context,
                new Error(result.stderr || result.stdout || "ssh environment upload failed"),
                { result }
            );
        }
        return environmentFile;
    }

    async #removeRemoteEnvironmentFile(environmentFile: string | undefined): Promise<void> {
        if (environmentFile === undefined) {
            return;
        }
        const commandLine = `rm -f ${shellEscape(environmentFile)}`;
        const context = this.#createRemoteShellContext("cleanupEnvironment", commandLine);
        const result = this.#decorateCommandResult(
            await this.#process.wait(
                this.#spawnRemoteShell(commandLine, ["ignore", "pipe", "pipe"], context),
                context
            )
        );
        if (result.exitCode !== 0) {
            throw this.#process.createError(
                context,
                new Error(result.stderr || result.stdout || "ssh environment cleanup failed"),
                { result }
            );
        }
    }

    #withRemoteEnvironment(commandLine: string, environmentFile: string | undefined): string {
        if (environmentFile === undefined) {
            return commandLine;
        }
        return [
            `env_file=${shellEscape(environmentFile)}`,
            `trap 'rm -f "$env_file"' EXIT HUP INT TERM`,
            "set -a",
            `. "$env_file"`,
            "set +a",
            `rm -f "$env_file"`,
            "trap - EXIT HUP INT TERM",
            `exec ${commandLine}`
        ].join("; ");
    }

    #createRemoteShellContext(
        operation: string,
        commandLine: string,
        options: { cwd?: string; instance?: string } = {}
    ): ProviderCommandContext {
        return createCommandContext({
            command: this.#buildRemoteShellCommand(commandLine),
            cwd: options.cwd,
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

    async #ensureInteractiveControlConnection(
        operation: string,
        instance: string | undefined,
        interactiveSession: WorkerCommandInteractiveSession
    ): Promise<void> {
        if (this.#controlSocketEnabled) {
            return;
        }

        const commandLine = ":";
        const context = createCommandContext({
            command: this.#buildInteractiveRemoteShellCommand(commandLine),
            instance,
            operation,
            provider: "ssh"
        });
        const result = await this.#runInteractiveRemoteShell(commandLine, context, interactiveSession);

        if (result.exitCode !== 0) {
            throw this.#process.createError(context, new Error(result.stderr || result.stdout || "ssh interactive authentication failed"), {
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
            commandLine
        ];

        return ["script", "-qefc", sshCommand.map(shellEscape).join(" "), "/dev/null"];
    }

    async #runInteractiveRemoteShell(
        commandLine: string,
        context: ProviderCommandContext,
        interactiveSession: WorkerCommandInteractiveSession
    ) {
        const child = this.#process.spawn(context, {
            stdio: ["pipe", "pipe", "pipe"]
        });

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
        const result = await this.#process.wait(child, context);

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

function isInternalWorkerEnvironmentKey(key: string): boolean {
    return key === "DEVSHELL_WORKER_INTERNAL_INSTANCE"
        || key === "DEVSHELL_WORKER_INTERNAL_WORKSPACE"
        || key === "DEVSHELL_WORKER_INTERNAL_SECURITY_MODE";
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
