import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import type { TuiAttachShellCommand, TuiAttachShellReadinessCheck, TuiAttachShellRunnerHooks } from "./TuiAttachShellModel.js";

export type TuiAttachShellSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export class TuiAttachShellRunner {
    readonly #hooks: TuiAttachShellRunnerHooks;
    readonly #spawn: TuiAttachShellSpawn;

    constructor(options: { hooks: TuiAttachShellRunnerHooks; spawn?: TuiAttachShellSpawn }) {
        this.#hooks = options.hooks;
        this.#spawn = options.spawn ?? spawn;
    }

    async run(command: TuiAttachShellCommand): Promise<void> {
        this.#hooks.suspend();

        try {
            await this.#ensureReady(command.readinessCheck);
            await this.#runWithFallback(command);
        } finally {
            this.#hooks.resume();
        }
    }

    async #runWithFallback(command: TuiAttachShellCommand): Promise<void> {
        try {
            const result = await this.#spawnAndWait(command);
            if (result.exitCode === command.fallbackOnExitCode) {
                await this.#runFallback(command);
            }
        } catch (error) {
            if (readErrorCode(error) !== "ENOENT") {
                throw error;
            }

            await this.#runFallback(command, error);
        }
    }

    async #runFallback(command: TuiAttachShellCommand, initialError?: unknown): Promise<void> {
        for (const fallback of command.fallbackCommands ?? []) {
            try {
                await this.#spawnAndWait(fallback);
                return;
            } catch (fallbackError) {
                if (readErrorCode(fallbackError) !== "ENOENT") {
                    throw fallbackError;
                }
            }
        }

        throw initialError ?? new Error("Attach Shell fallback command is unavailable.");
    }

    async #ensureReady(check: TuiAttachShellReadinessCheck | undefined): Promise<void> {
        if (check === undefined) {
            return;
        }

        const result = await this.#spawnAndCollect(check);
        if (result.exitCode !== 0 || !result.stdout.split(/\r?\n/u).some((line) => line.trim() === check.expectedOutput)) {
            throw new Error("Container is not running. Use Start Worker first.");
        }
    }

    #spawnAndWait(command: TuiAttachShellCommand): Promise<{ exitCode: number | null }> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (exitCode: number | null, error?: Error): void => {
                if (settled) {
                    return;
                }

                settled = true;
                if (error === undefined) {
                    resolve({ exitCode });
                    return;
                }

                reject(error);
            };

            let child: ChildProcess;
            try {
                child = this.#spawn(command.command, command.args, {
                    cwd: command.cwd,
                    stdio: "inherit"
                });
            } catch (error) {
                finish(null, asError(error));
                return;
            }

            child.once("error", (error) => finish(null, error));
            child.once("close", (code) => finish(code));
        });
    }

    #spawnAndCollect(check: TuiAttachShellReadinessCheck): Promise<{ exitCode: number | null; stdout: string }> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const output: Buffer[] = [];
            const finish = (exitCode: number | null, error?: Error): void => {
                if (settled) {
                    return;
                }

                settled = true;
                if (error === undefined) {
                    resolve({ exitCode, stdout: Buffer.concat(output).toString() });
                    return;
                }

                reject(error);
            };

            let child: ChildProcess;
            try {
                child = this.#spawn(check.command, check.args, { stdio: ["ignore", "pipe", "ignore"] });
            } catch (error) {
                finish(null, asError(error));
                return;
            }

            child.stdout?.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
            child.once("error", (error) => finish(null, error));
            child.once("close", (code) => finish(code));
        });
    }
}

function readErrorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
