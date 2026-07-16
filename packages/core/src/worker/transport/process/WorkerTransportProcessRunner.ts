import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import { errorCodes, type CommandResult, type ControlError } from "@portable-devshell/shared";

import {
    type ProviderCommandContext,
    type SpawnFunction,
    type WorkerCommandResult
} from "../../command/WorkerCommandTransport.js";
import { createProviderError } from "./WorkerTransportProcessError.js";
import { waitForCommandResult } from "./WorkerTransportProcessResult.js";

export class WorkerTransportProcessRunner {
    readonly #spawn: SpawnFunction;

    constructor(spawnFunction: SpawnFunction = spawn) {
        this.#spawn = spawnFunction;
    }

    spawn(
        context: ProviderCommandContext,
        options: SpawnOptions,
        errorCode: string = errorCodes.coreProviderFailed
    ): ChildProcess {
        const [command, ...args] = context.command;

        try {
            return this.#spawn(command, args, options);
        } catch (error) {
            throw this.createError(context, error, { errorCode });
        }
    }

    async run(
        context: ProviderCommandContext,
        options: SpawnOptions,
        errorCode: string = errorCodes.coreProviderFailed
    ): Promise<WorkerCommandResult> {
        return await this.wait(this.spawn(context, options, errorCode), context);
    }

    async wait(child: ChildProcess, context: ProviderCommandContext): Promise<WorkerCommandResult> {
        return await waitForCommandResult(child, this.createError, context);
    }

    readonly createError = (
        context: ProviderCommandContext,
        cause: unknown,
        options?: { errorCode?: string; result?: Partial<CommandResult> }
    ): ControlError => createProviderError(context, cause, options);
}
