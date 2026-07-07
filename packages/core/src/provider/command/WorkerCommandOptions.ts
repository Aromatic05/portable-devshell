export type WorkerCommandName = "start" | "status" | "stop" | "logs";

export interface WorkerCommandOptions {
    instanceName: string;
    workspacePath?: string;
    extraArgs?: readonly string[];
    env?: NodeJS.ProcessEnv;
}

export interface WorkerRpcOptions {
    instanceName: string;
    env?: NodeJS.ProcessEnv;
}
