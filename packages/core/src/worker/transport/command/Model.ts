export type WorkerCommandName = "start" | "status" | "stop" | "logs" | "retire";

export interface WorkerCommandOptions {
    instanceName: string;
    extraArgs?: readonly string[];
    env?: NodeJS.ProcessEnv;
}

export interface WorkerChannelOptions {
    instanceName: string;
    env?: NodeJS.ProcessEnv;
}

export type WorkerRpcOptions = WorkerChannelOptions;
