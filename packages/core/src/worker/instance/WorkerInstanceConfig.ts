import type { ApprovalPolicy, ApprovalTimeout, EffectiveSecurityMode, InstanceName, WorkspacePath } from "@portable-devshell/shared";

import type { WorkerCommandTransport } from "../command/WorkerCommandTransport.js";
import type { WorkerHandshakeParams } from "../../worker/protocol/WorkerProtocolClient.js";

export interface WorkerInstanceConfig {
    effectiveSecurityMode?: EffectiveSecurityMode;
    name: InstanceName;
    transport: WorkerCommandTransport;
    defaultWorkspace?: WorkspacePath;
    allowTools?: readonly string[];
    homeDirectory?: string;
    env?: NodeJS.ProcessEnv;
    eventBufferSize?: number;
    handshake?: Partial<WorkerHandshakeParams>;
    approvalPolicy?: ApprovalPolicy;
    approvalTimeout?: ApprovalTimeout;
}

export interface ResolvedWorkerInstanceConfig extends WorkerInstanceConfig {
    allowTools: readonly string[];
    effectiveSecurityMode: EffectiveSecurityMode;
    eventBufferSize: number;
    handshake: WorkerHandshakeParams;
}

export function resolveWorkerInstanceConfig(config: WorkerInstanceConfig): ResolvedWorkerInstanceConfig {
    return {
        ...config,
        allowTools: config.allowTools ?? [],
        effectiveSecurityMode: config.effectiveSecurityMode ?? "disabled",
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
