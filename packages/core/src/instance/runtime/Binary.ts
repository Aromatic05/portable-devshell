export interface WorkerBinaryCommand {
    command: string;
    args: string[];
}

export type WorkerCommandName = "start" | "status" | "stop" | "logs" | "retire";

export class WorkerBinary {
    readonly executable: string;

    constructor(executable = "devshell-worker") {
        this.executable = executable;
    }

    buildCommand(
        subcommand: WorkerCommandName | "transport",
        instanceName: string,
        extraArgs: readonly string[] = [],
    ): WorkerBinaryCommand {
        return {
            command: this.executable,
            args: [subcommand, "--instance", instanceName, ...extraArgs],
        };
    }

    buildInstallCommand(): WorkerBinaryCommand {
        return {
            command: this.executable,
            args: ["--version"],
        };
    }
}
