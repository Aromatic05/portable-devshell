import {
    spawn,
    type ChildProcess,
    type SpawnOptions,
} from "node:child_process";

import {
    runtimeErrorCodes,
    StreamChannel,
    type Channel,
    type CommandResult,
    type RemoteError,
} from "@portable-devshell/shared";

import { type ProviderCommandContext, type SpawnFunction } from "./Command.js";
import { createProviderError } from "./Error.js";
import { waitForCommandResult } from "./Command.js";

export class ProcessRunner {
    readonly #spawn: SpawnFunction;

    constructor(spawnFunction: SpawnFunction = spawn) {
        this.#spawn = spawnFunction;
    }

    spawn(
        context: ProviderCommandContext,
        options: SpawnOptions,
        errorCode: string = runtimeErrorCodes.providerFailed,
    ): ChildProcess {
        const [command, ...args] = context.command;

        try {
            return this.#spawn(command, args, options);
        } catch (error) {
            throw this.createError(context, error, { errorCode });
        }
    }

    createChannel(
        child: ChildProcess,
        context: ProviderCommandContext,
    ): Channel {
        const { stdin, stdout, stderr } = child;
        if (stdin === null || stdout === null || stderr === null) {
            try {
                child.kill("SIGTERM");
            } catch {
                // The provider error below is authoritative.
            }
            throw this.createError(
                context,
                new Error(
                    "Worker transport process must expose stdin, stdout, and stderr.",
                ),
            );
        }

        stderr.resume();
        const channel = new StreamChannel(stdout, stdin, {
            closeTransport: () => {
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill("SIGTERM");
                }
            },
        });
        child.once("error", (error) => {
            channel.close(this.createError(context, error));
        });
        child.once("exit", (code, signal) => {
            if (channel.closed) return;
            if (code === 0) {
                channel.close();
                return;
            }
            channel.close(
                this.createError(
                    context,
                    new Error(
                        `Worker transport process exited with code ${String(code)} signal ${String(signal)}.`,
                    ),
                ),
            );
        });
        return channel;
    }

    async run(
        context: ProviderCommandContext,
        options: SpawnOptions & { input?: Uint8Array },
        errorCode: string = runtimeErrorCodes.providerFailed,
    ): Promise<CommandResult> {
        const { input, ...spawnOptions } = options;
        const child = this.spawn(context, spawnOptions, errorCode);
        const completion = this.wait(child, context);
        if (input === undefined) return await completion;
        if (child.stdin === null) {
            child.kill();
            await completion.catch(() => undefined);
            throw this.createError(context, new Error("Worker connection stdin is unavailable."));
        }
        const stdin = child.stdin;
        const upload = new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                stdin.off("error", onError);
                stdin.off("finish", onFinish);
            };
            const onError = (error: Error) => {
                cleanup();
                reject(this.createError(context, error));
            };
            const onFinish = () => {
                cleanup();
                resolve();
            };
            stdin.once("error", onError);
            stdin.once("finish", onFinish);
            stdin.end(input);
        });
        try {
            const [result] = await Promise.all([completion, upload]);
            return result;
        } catch (error) {
            child.kill();
            throw error;
        }
    }

    async wait(
        child: ChildProcess,
        context: ProviderCommandContext,
    ): Promise<CommandResult> {
        return await waitForCommandResult(child, this.createError, context);
    }

    readonly createError = (
        context: ProviderCommandContext,
        cause: unknown,
        options?: { errorCode?: string; result?: Partial<CommandResult> },
    ): RemoteError => createProviderError(context, cause, options);
}
