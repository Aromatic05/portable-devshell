import type { ApprovalPolicy, ApprovalTimeout, EffectiveSecurityMode, InstanceName, WorkspacePath } from "@portable-devshell/shared";

import type { WorkerCommandTransport } from "../command/WorkerCommandTransport.js";
import type { WorkerHandshakeParams } from "../../worker/protocol/WorkerProtocolClient.js";
import type { WorkerRpcConnector } from "../rpc/WorkerRpcChannel.js";
import { resolveToolSchedulerLimits, type ToolSchedulerLimits } from "../tool/ToolCallScheduler.js";
import {
    resolveAuditStorageLimits,
    type AuditStorageLimits
} from "../../audit/AuditStorageLimits.js";

export type WorkerManagementMode = "controllerManaged" | "selfManaged";

interface WorkerInstanceConfigCommon {
    effectiveSecurityMode?: EffectiveSecurityMode;
    name: InstanceName;
    defaultWorkspace?: WorkspacePath;
    homeDirectory?: string;
    env?: NodeJS.ProcessEnv;
    eventBufferSize?: number;
    auditStorage?: Partial<AuditStorageLimits>;
    handshake?: Partial<WorkerHandshakeParams>;
    approvalPolicy?: ApprovalPolicy;
    approvalTimeout?: ApprovalTimeout;
    toolScheduler?: Partial<ToolSchedulerLimits>;
}

export type WorkerInstanceConfig =
    | (WorkerInstanceConfigCommon & {
          managementMode?: "controllerManaged";
          rpcConnector?: never;
          transport: WorkerCommandTransport;
      })
    | (WorkerInstanceConfigCommon & {
          managementMode: "selfManaged";
          rpcConnector: WorkerRpcConnector;
          transport?: never;
      });

export interface ResolvedWorkerInstanceConfig extends WorkerInstanceConfigCommon {
    auditStorage: AuditStorageLimits;
    effectiveSecurityMode: EffectiveSecurityMode;
    eventBufferSize: number;
    handshake: WorkerHandshakeParams;
    managementMode: WorkerManagementMode;
    rpcConnector?: WorkerRpcConnector;
    toolScheduler: ToolSchedulerLimits;
    transport?: WorkerCommandTransport;
}

export function resolveWorkerInstanceConfig(config: WorkerInstanceConfig): ResolvedWorkerInstanceConfig {
    const managementMode = config.managementMode ?? "controllerManaged";

    if (managementMode === "controllerManaged" && config.transport === undefined) {
        throw new TypeError("controller-managed worker requires a command transport");
    }
    if (managementMode === "selfManaged" && config.rpcConnector === undefined) {
        throw new TypeError("self-managed worker requires an inbound RPC connector");
    }

    return {
        ...config,
        auditStorage: resolveAuditStorageLimits(config.auditStorage),
        effectiveSecurityMode: config.effectiveSecurityMode ?? "disabled",
        eventBufferSize: config.eventBufferSize ?? 100,
        handshake: {
            minProtocolVersion: 2,
            maxProtocolVersion: 2,
            clientName: "portable-devshell",
            clientVersion: "0.0.0",
            ...config.handshake
        },
        managementMode,
        toolScheduler: resolveToolSchedulerLimits(config.toolScheduler)
    };
}
