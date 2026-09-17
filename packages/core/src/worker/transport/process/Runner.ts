import {
    spawn,
    type ChildProcess,
    type SpawnOptions,
} from "node:child_process";

import {
    errorCodes,
    StreamChannel,
    type Channel,
    type CommandResult,
    type ControlError,
} from "@portable-devshell/shared";

import {
    type ProviderCommandContext,
    type SpawnFunction,
    type WorkerCommandResult,
} from "../command/Transport.js";
import { createProviderError } from "./Error.js";
import { waitForCommandResult } from "./Result.js";

export class WorkerTransportProcessRunner {
    readonly #spawn: SpawnFunction;

    constructor(spawnFunction: SpawnFunction = spawn) {
        this.#spawn = spawnFunction;
    }

    spawn(
        context: ProviderCommandContext,
        options: SpawnOptions,
        errorCode: string = errorCodes.coreProviderFailed,
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
                new Error("Worker transport process must expose stdin, stdout, and stderr."),
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
        options: SpawnOptions,
        errorCode: string = errorCodes.coreProviderFailed,
    ): Promise<WorkerCommandResult> {
        return await this.wait(
            this.spawn(context, options, errorCode),
            context,
        );
    }

    async wait(
        child: ChildProcess,
        context: ProviderCommandContext,
    ): Promise<WorkerCommandResult> {
        return await waitForCommandResult(child, this.createError, context);
    }

    readonly createError = (
        context: ProviderCommandContext,
        cause: unknown,
        options?: { errorCode?: string; result?: Partial<CommandResult> },
    ): ControlError => createProviderError(context, cause, options);
}
