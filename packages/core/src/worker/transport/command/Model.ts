export type WorkerCommandName = "start" | "status" | "stop" | "logs" | "retire";

export interface WorkerCommandOptions {
    instanceName: string;
    extraArgs?: readonly string[];
    env?: NodeJS.ProcessEnv;
}

export interface WorkerRpcOptions {
    instanceName: string;
    env?: NodeJS.ProcessEnv;
}
