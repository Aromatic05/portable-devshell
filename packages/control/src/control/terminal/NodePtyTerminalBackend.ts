import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { spawn, type IPty } from "node-pty";

import type {
    TerminalBackend,
    TerminalBackendOpenInput,
    TerminalProcess,
    TerminalProcessExit,
} from "./TerminalProcess.js";

export interface TerminalLaunchPlan {
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    executable: string;
    initialInput?: string;
}

export interface NodePtyTerminalBackendOptions {
    ptySpawn?: typeof spawn;
    resolve(input: TerminalBackendOpenInput): TerminalLaunchPlan;
}

export class NodePtyTerminalBackend implements TerminalBackend {
    readonly #ptySpawn: typeof spawn;
    readonly #resolve: NodePtyTerminalBackendOptions["resolve"];

    constructor(options: NodePtyTerminalBackendOptions) {
        this.#ptySpawn = options.ptySpawn ?? spawn;
        this.#resolve = options.resolve;
    }

    async open(input: TerminalBackendOpenInput): Promise<TerminalProcess> {
        const plan = this.#resolve(input);
        if (plan.executable.length === 0) {
            throw new Error("Terminal executable must not be empty.");
        }
        const startup = await prepareShellStartup(plan);
        try {
            const pty = this.#ptySpawn(plan.executable, plan.args, {
                cols: input.cols,
                ...(plan.cwd === undefined ? {} : { cwd: plan.cwd }),
                env: terminalEnvironment(startup.environment),
                name: "xterm-256color",
                rows: input.rows,
            });
            const process = new NodePtyTerminalProcess(pty, startup.cleanup);
            if (plan.initialInput !== undefined && plan.initialInput.length > 0) {
                pty.write(plan.initialInput);
            }
            return process;
        } catch (error) {
            await startup.cleanup();
            throw error;
        }
    }
}

class NodePtyTerminalProcess implements TerminalProcess {
    #cleaned = false;

    constructor(
        private readonly pty: IPty,
        private readonly cleanup: () => Promise<void>,
    ) {
        this.pty.onExit(() => {
            void this.#cleanupOnce();
        });
    }

    kill(): void {
        this.pty.kill();
        void this.#cleanupOnce();
    }

    onData(listener: (data: string) => void): () => void {
        const disposable = this.pty.onData(listener);
        return () => disposable.dispose();
    }

    onExit(listener: (exit: TerminalProcessExit) => void): () => void {
        const disposable = this.pty.onExit((exit) => listener({
            exitCode: exit.exitCode,
            signal: exit.signal ?? 0,
        }));
        return () => disposable.dispose();
    }

    resize(cols: number, rows: number): void {
        this.pty.resize(cols, rows);
    }

    write(data: string): void {
        this.pty.write(data);
    }

    async #cleanupOnce(): Promise<void> {
        if (this.#cleaned) return;
        this.#cleaned = true;
        await this.cleanup();
    }
}

interface PreparedShellStartup {
    cleanup(): Promise<void>;
    environment: NodeJS.ProcessEnv;
}

async function prepareShellStartup(
    plan: TerminalLaunchPlan,
): Promise<PreparedShellStartup> {
    const environment = { ...(plan.env ?? process.env) };
    if (
        process.platform === "win32" ||
        basename(plan.executable) !== "zsh" ||
        (environment.ZDOTDIR?.length ?? 0) > 0
    ) {
        return { cleanup: async () => undefined, environment };
    }

    const directory = await mkdtemp(
        join(tmpdir(), "portable-devshell-zsh-"),
    );
    try {
        await chmod(directory, 0o700);
        await Promise.all(
            [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"].map(
                async (file) =>
                    await writeFile(
                        join(directory, file),
                        `if [ -r "$HOME/${file}" ]; then\n  source "$HOME/${file}"\nfi\n`,
                        { encoding: "utf8", mode: 0o600 },
                    ),
            ),
        );
    } catch (error) {
        await rm(directory, { force: true, recursive: true });
        throw error;
    }
    return {
        cleanup: async () =>
            await rm(directory, { force: true, recursive: true }),
        environment: { ...environment, ZDOTDIR: directory },
    };
}

function terminalEnvironment(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
    return Object.fromEntries(
        Object.entries({
            ...environment,
            COLORTERM: environment.COLORTERM ?? "truecolor",
            TERM: environment.TERM ?? "xterm-256color",
        }).filter((entry): entry is [string, string] => entry[1] !== undefined)
    );
}
