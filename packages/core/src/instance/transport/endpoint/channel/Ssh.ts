import { Worker, type WorkerConnection } from "./worker/index.js";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createRemoteError,
    runtimeErrorCodes,
} from "@portable-devshell/shared";
import { parseArgsStringToArgv } from "string-argv";

import { type ChannelCommandOptions, type CommandOptions } from "./worker/Command.js";
import {
    type WorkerCommandInteractiveSession,
    type SpawnFunction,
    type ProviderCommandContext,
} from "./worker/Command.js";
import { createCommandContext } from "./worker/Error.js";
import { ProcessRunner } from "./worker/Process.js";

const SSH_NON_INTERACTIVE_ARGS = [
    "-oBatchMode=yes",
    "-oNumberOfPasswordPrompts=0",
    "-oKbdInteractiveAuthentication=no",
    "-oPasswordAuthentication=no",
] as const;
const SSH_INTERACTIVE_HINT =
    "portable-devshell: ssh command requires interactive authentication or host confirmation; non-interactive control commands fail fast.";

export interface SshConnectionOptions {
    command: string;
    spawnFunction?: SpawnFunction;
}

export class SshConnection implements WorkerConnection {
    #channel = new SshChannel(this);
    readonly #sshCommand: readonly [string, ...string[]];
    readonly #process: ProcessRunner;
    readonly #controlPath = join(
        tmpdir(),
        `pds-ssh-${randomUUID().slice(0, 8)}`,
    );
    #controlSocketEnabled = false;

    constructor(options: SshConnectionOptions) {
        this.#sshCommand = parseSshCommand(options.command);
        this.#process = new ProcessRunner(options.spawnFunction);
    }

    get channel(): SshChannel {
        if (this.#channel.closed) this.#channel = new SshChannel(this);
        return this.#channel;
    }

    async #run(context: ProviderCommandContext, options: Pick<CommandOptions, "input"> = {}) {
        return this.#decorateCommandResult(await this.#process.run(context, {
            input: options.input,
            stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        }));
    }

    async runCommand(
        operation: string,
        command: readonly string[],
        options: CommandOptions = {},
    ) {
        if (options.interactiveSession !== undefined)
            await this.#ensureInteractiveControlConnection(
                operation,
                options.instance,
                options.interactiveSession,
            );
        const environmentFile = await this.#prepareRemoteEnvironment(
            options.env,
        );
        const commandLine = this.#withRemoteEnvironment(
            command.map(shellEscape).join(" "),
            environmentFile,
        );
        const context = this.#createRemoteShellContext(
            operation,
            commandLine,
            { instance: options.instance },
        );
        try {
            const result = await this.#run(context, { input: options.input });
            if (result.exitCode !== 0)
                await this.#removeRemoteEnvironmentFile(environmentFile);
            return result;
        } catch (error) {
            await this.#removeRemoteEnvironmentFile(environmentFile).catch(
                () => undefined,
            );
            throw error;
        }
    }

    async openChannel(operation: string, command: readonly string[], options: ChannelCommandOptions = {}): Promise<SshChannel> {
        if (options.interactiveSession !== undefined)
            await this.#ensureInteractiveControlConnection(operation, options.instance, options.interactiveSession);
        const environmentFile = await this.#prepareRemoteEnvironment(options.env);
        const commandLine = this.#withRemoteEnvironment(command.map(shellEscape).join(" "), environmentFile);
        const context = this.#createRemoteShellContext(operation, commandLine, { instance: options.instance });
        try {
            const child = this.#process.spawn(context, { stdio: ["pipe", "pipe", "pipe"] });
            child.once("exit", () => { void this.#removeRemoteEnvironmentFile(environmentFile).catch(() => undefined); });
            if (this.#channel.connected) this.#channel.close();
            const channel = this.channel;
            channel.attach(this.#process.createChannel(child, context));
            return channel;
        } catch (error) {
            await this.#removeRemoteEnvironmentFile(environmentFile).catch(() => undefined);
            throw error;
        }
    }

    async #prepareRemoteEnvironment(
        env: NodeJS.ProcessEnv | undefined,
    ): Promise<string | undefined> {
        const entries = Object.entries(env ?? {})
            .filter(
                (entry): entry is [string, string] =>
                    entry[1] !== undefined &&
                    !isInternalWorkerEnvironmentKey(entry[0]),
            )
            .sort(([left], [right]) => left.localeCompare(right));
        if (entries.length === 0) {
            return undefined;
        }
        for (const [key, value] of entries) {
            if (
                !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
                value.includes("\0")
            ) {
                throw createRemoteError({
                    code: runtimeErrorCodes.providerFailed,
                    details: { environmentKey: key, provider: "ssh" },
                    message: `SSH instance environment key ${key} cannot be represented safely.`,
                    retryable: false,
                });
            }
        }

        const environmentFile = `/tmp/portable-devshell-env-${randomUUID()}.sh`;
        const commandLine = `umask 077; cat > ${shellEscape(environmentFile)}`;
        const context = this.#createRemoteShellContext(
            "prepareEnvironment",
            commandLine,
        );
        const contents = `${entries.map(([key, value]) => `${key}=${shellEscape(value)}`).join("\n")}\n`;
        const result = await this.#run(context, { input: Buffer.from(contents) });
        if (result.exitCode !== 0) {
            throw this.#process.createError(
                context,
                new Error(
                    result.stderr ||
                        result.stdout ||
                        "ssh environment upload failed",
                ),
                { result },
            );
        }
        return environmentFile;
    }

    async #removeRemoteEnvironmentFile(
        environmentFile: string | undefined,
    ): Promise<void> {
        if (environmentFile === undefined) {
            return;
        }
        const commandLine = `rm -f ${shellEscape(environmentFile)}`;
        const context = this.#createRemoteShellContext(
            "cleanupEnvironment",
            commandLine,
        );
        const result = await this.#run(context);
        if (result.exitCode !== 0) {
            throw this.#process.createError(
                context,
                new Error(
                    result.stderr ||
                        result.stdout ||
                        "ssh environment cleanup failed",
                ),
                { result },
            );
        }
    }

    #withRemoteEnvironment(
        commandLine: string,
        environmentFile: string | undefined,
    ): string {
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
            `exec ${commandLine}`,
        ].join("; ");
    }

    #createRemoteShellContext(
        operation: string,
        commandLine: string,
        options: { cwd?: string; instance?: string } = {},
    ): ProviderCommandContext {
        return createCommandContext({
            command: this.#buildRemoteShellCommand(commandLine),
            cwd: options.cwd,
            instance: options.instance,
            operation,
            provider: "ssh",
        });
    }

    #buildRemoteShellCommand(commandLine: string): [string, ...string[]] {
        return [
            this.#sshCommand[0],
            ...SSH_NON_INTERACTIVE_ARGS,
            ...(this.#controlSocketEnabled
                ? this.#buildControlSocketArgs()
                : []),
            ...this.#sshCommand.slice(1),
            "--",
            "sh",
            "-lc",
            shellEscape(commandLine),
        ];
    }

    #decorateCommandResult<
        T extends {
            details?: ProviderCommandContext | Record<string, unknown>;
            exitCode: number | null;
            stderr: string;
            stdout: string;
        },
    >(result: T): T {
        const stderr = this.#appendInteractiveHint(
            result.exitCode,
            result.stderr,
        );
        if (stderr === result.stderr) {
            return result;
        }

        const details = result.details;
        if (
            details !== undefined &&
            "stderrTail" in details &&
            typeof details.stderrTail === "string"
        ) {
            details.stderrTail = stderr;
        }

        return {
            ...result,
            stderr,
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

        return stderr.includes(SSH_INTERACTIVE_HINT)
            ? stderr
            : `${stderr}${stderr.endsWith("\n") || stderr.length === 0 ? "" : "\n"}${SSH_INTERACTIVE_HINT}\n`;
    }

    async #ensureInteractiveControlConnection(
        operation: string,
        instance: string | undefined,
        interactiveSession: WorkerCommandInteractiveSession,
    ): Promise<void> {
        if (this.#controlSocketEnabled) {
            return;
        }

        const commandLine = ":";
        const context = createCommandContext({
            command: this.#buildInteractiveRemoteShellCommand(commandLine),
            instance,
            operation,
            provider: "ssh",
        });
        const result = await this.#runInteractiveRemoteShell(
            commandLine,
            context,
            interactiveSession,
        );

        if (result.exitCode !== 0) {
            throw this.#process.createError(
                context,
                new Error(
                    result.stderr ||
                        result.stdout ||
                        "ssh interactive authentication failed",
                ),
                {
                    result,
                },
            );
        }

        this.#controlSocketEnabled = true;
    }

    #buildControlSocketArgs(): string[] {
        return [
            `-oControlPath=${this.#controlPath}`,
            "-oControlMaster=auto",
            "-oControlPersist=600",
        ];
    }

    #buildInteractiveRemoteShellCommand(
        commandLine: string,
    ): [string, ...string[]] {
        const sshCommand = [
            this.#sshCommand[0],
            ...this.#buildControlSocketArgs(),
            ...this.#sshCommand.slice(1),
            "--",
            "sh",
            "-lc",
            commandLine,
        ];

        return [
            "script",
            "-qefc",
            sshCommand.map(shellEscape).join(" "),
            "/dev/null",
        ];
    }

    async #runInteractiveRemoteShell(
        commandLine: string,
        context: ProviderCommandContext,
        interactiveSession: WorkerCommandInteractiveSession,
    ) {
        const child = this.#process.spawn(context, {
            stdio: ["pipe", "pipe", "pipe"],
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
        const inputPump = this.#pumpInteractiveInput(
            child.stdin,
            interactiveSession,
            exitSignal,
        );
        const result = await this.#process.wait(child, context);

        await inputPump;
        await outputFlush;

        return result;
    }

    async #pumpInteractiveInput(
        stdin: NodeJS.WritableStream | null,
        interactiveSession: WorkerCommandInteractiveSession,
        exitSignal: Promise<undefined>,
    ): Promise<void> {
        if (stdin === null) {
            return;
        }

        for (;;) {
            const chunk = await Promise.race([
                interactiveSession.readInput(),
                exitSignal,
            ]);
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
    return (
        key === "DEVSHELL_WORKER_INTERNAL_INSTANCE" ||
        key === "DEVSHELL_WORKER_INTERNAL_WORKSPACE" ||
        key === "DEVSHELL_WORKER_INTERNAL_SECURITY_MODE"
    );
}

function parseSshCommand(command: string): [string, ...string[]] {
    const parsed = parseArgsStringToArgv(command).filter(
        (entry) => entry.length > 0,
    );
    if (parsed.length === 0) {
        throw new Error("ssh.command must not be empty");
    }

    return [parsed[0], ...parsed.slice(1)];
}

function shellEscape(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

export class SshChannel extends Worker<SshConnection> {}
