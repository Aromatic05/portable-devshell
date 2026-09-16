import type { Channel } from "@portable-devshell/shared";

import type { WorkerRpcProcess } from "../protocol/rpc/Process.js";
import type {
    WorkerCommandInteractiveSession,
    WorkerCommandResult,
} from "./command/Transport.js";
import type {
    WorkerChannelOptions,
    WorkerCommandName,
    WorkerCommandOptions,
    WorkerRpcOptions,
} from "./command/Model.js";

export interface WorkerTransport {
    connectWorkerChannel(options: WorkerChannelOptions): Promise<Channel>;
    retireProviderResources?(): Promise<void>;
    runWorkerCommand(
        command: WorkerCommandName,
        options: WorkerCommandOptions,
        interactiveSession?: WorkerCommandInteractiveSession,
    ): Promise<WorkerCommandResult>;
    spawnWorkerRpc(options: WorkerRpcOptions): Promise<WorkerRpcProcess>;
    installWorker(
        interactiveSession?: WorkerCommandInteractiveSession,
    ): Promise<void>;
}
