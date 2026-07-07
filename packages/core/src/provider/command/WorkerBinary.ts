import type { WorkerCommandName } from "./WorkerCommandOptions.js";

export interface WorkerBinaryCommand {
    command: string;
    args: string[];
}

export class WorkerBinary {
    readonly executable: string;

    constructor(executable = "devshell-worker") {
        this.executable = executable;
    }

    buildCommand(
        subcommand: WorkerCommandName | "rpc",
        instanceName: string,
        extraArgs: readonly string[] = []
    ): WorkerBinaryCommand {
        return {
            command: this.executable,
            args: [subcommand, "--instance", instanceName, ...extraArgs]
        };
    }

    buildInstallCommand(): WorkerBinaryCommand {
        return {
            command: this.executable,
            args: ["--version"]
        };
    }
}
