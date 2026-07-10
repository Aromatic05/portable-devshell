import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import type { AttachShellCommand, AttachShellRunnerHooks } from "./AttachShellTypes.js";

export type AttachShellSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export class AttachShellRunner {
    readonly #hooks: AttachShellRunnerHooks;
    readonly #spawn: AttachShellSpawn;

    constructor(options: { hooks: AttachShellRunnerHooks; spawn?: AttachShellSpawn }) {
        this.#hooks = options.hooks;
        this.#spawn = options.spawn ?? spawn;
    }

    async run(command: AttachShellCommand): Promise<void> {
        this.#hooks.suspend();

        try {
            await this.#runWithFallback(command);
        } finally {
            this.#hooks.resume();
        }
    }

    async #runWithFallback(command: AttachShellCommand): Promise<void> {
        try {
            await this.#spawnAndWait(command);
        } catch (error) {
            if (readErrorCode(error) !== "ENOENT") {
                throw error;
            }

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

            throw error;
        }
    }

    #spawnAndWait(command: AttachShellCommand): Promise<void> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error?: Error): void => {
                if (settled) {
                    return;
                }

                settled = true;
                if (error === undefined) {
                    resolve();
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
                finish(asError(error));
                return;
            }

            child.once("error", (error) => finish(error));
            child.once("close", () => finish());
        });
    }
}

function readErrorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
