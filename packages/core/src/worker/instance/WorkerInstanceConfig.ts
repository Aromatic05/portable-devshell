import type { InstanceName, WorkspacePath } from "@portable-devshell/shared";

import type { WorkerCommandTransport } from "../command/WorkerCommandTransport.js";
import type { WorkerHandshakeParams } from "../../worker/protocol/WorkerProtocolClient.js";

export interface WorkerInstanceConfig {
    name: InstanceName;
    transport: WorkerCommandTransport;
    defaultWorkspace?: WorkspacePath;
    allowTools?: readonly string[];
    homeDirectory?: string;
    env?: NodeJS.ProcessEnv;
    eventBufferSize?: number;
    handshake?: Partial<WorkerHandshakeParams>;
}

export interface ResolvedWorkerInstanceConfig extends WorkerInstanceConfig {
    allowTools: readonly string[];
    eventBufferSize: number;
    handshake: WorkerHandshakeParams;
}

export function resolveWorkerInstanceConfig(config: WorkerInstanceConfig): ResolvedWorkerInstanceConfig {
    return {
        ...config,
        allowTools: config.allowTools ?? [],
        eventBufferSize: config.eventBufferSize ?? 100,
        handshake: {
            minProtocolVersion: 1,
            maxProtocolVersion: 1,
            clientName: "portable-devshell",
            clientVersion: "0.0.0",
            ...config.handshake
        }
    };
}
