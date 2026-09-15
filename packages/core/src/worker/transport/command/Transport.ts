import type { ChildProcess, SpawnOptions } from "node:child_process";

import type { CommandDiagnostic, CommandResult } from "@portable-devshell/shared";

import type { WorkerRpcProcess } from "../../protocol/rpc/Process.js";
import type { WorkerCommandName, WorkerCommandOptions, WorkerRpcOptions } from "./Model.js";

export type WorkerCommandResult = CommandResult;

export interface WorkerCommandInteractiveSession {
    readInput(): Promise<Buffer | undefined>;
    writeOutput(chunk: string): Promise<void> | void;
}

export interface ProviderCommandContext extends CommandDiagnostic {
    command: string[];
    commandDisplay: string;
    instance?: string;
    operation: string;
    provider: string;
}

export interface WorkerCommandTransport {
    retireProviderResources?(): Promise<void>;
    runWorkerCommand(
        command: WorkerCommandName,
        options: WorkerCommandOptions,
        interactiveSession?: WorkerCommandInteractiveSession
    ): Promise<WorkerCommandResult>;
    spawnWorkerRpc(options: WorkerRpcOptions): Promise<WorkerRpcProcess>;
    installWorker(interactiveSession?: WorkerCommandInteractiveSession): Promise<void>;
}

export type SpawnFunction = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export { createCommandContext, createProviderError } from "../process/Error.js";
export { waitForCommandResult } from "../process/Result.js";
