import type {
    ApprovalPolicy,
    ApprovalTimeout,
    ControlInstanceAlertsConfig,
    EffectiveSecurityMode,
    InstanceName,
} from "@portable-devshell/shared";

import type {
    WorkerTransport,
    WorkerTransportConnection,
} from "../transport/Transport.js";
import {
    WORKER_PROTOCOL_VERSION,
    type WorkerHandshakeParams,
} from "../protocol/Client.js";
import {
    resolveWorkerToolSchedulerLimits,
    type WorkerToolSchedulerLimits,
} from "../tool/Scheduler.js";
import {
    resolveAuditStorageLimits,
    type AuditStorageLimits,
} from "../../storage/audit/database/Limits.js";

export type WorkerManagementMode = "controllerManaged" | "selfManaged";

interface WorkerInstanceConfigCommon {
    alerts?: ControlInstanceAlertsConfig;
    effectiveSecurityMode?: EffectiveSecurityMode;
    name: InstanceName;
    homeDirectory?: string;
    env?: NodeJS.ProcessEnv;
    eventBufferSize?: number;
    auditStorage?: Partial<AuditStorageLimits>;
    handshake?: Partial<WorkerHandshakeParams>;
    approvalPolicy?: ApprovalPolicy;
    approvalTimeout?: ApprovalTimeout;
    toolScheduler?: Partial<WorkerToolSchedulerLimits>;
}

export type WorkerInstanceConfig =
    | (WorkerInstanceConfigCommon & {
          managementMode?: "controllerManaged";
          transportConnection?: never;
          transport: WorkerTransport;
      })
    | (WorkerInstanceConfigCommon & {
          managementMode: "selfManaged";
          transportConnection: WorkerTransportConnection;
          transport?: never;
      });

export interface ResolvedWorkerInstanceConfig extends WorkerInstanceConfigCommon {
    auditStorage: AuditStorageLimits;
    effectiveSecurityMode: EffectiveSecurityMode;
    eventBufferSize: number;
    handshake: WorkerHandshakeParams;
    managementMode: WorkerManagementMode;
    transportConnection?: WorkerTransportConnection;
    toolScheduler: WorkerToolSchedulerLimits;
    transport?: WorkerTransport;
}

export function resolveWorkerInstanceConfig(
    config: WorkerInstanceConfig,
): ResolvedWorkerInstanceConfig {
    const managementMode = config.managementMode ?? "controllerManaged";

    if (
        managementMode === "controllerManaged" &&
        config.transport === undefined
    ) {
        throw new TypeError(
            "controller-managed worker requires a command transport",
        );
    }
    if (
        managementMode === "selfManaged" &&
        config.transportConnection === undefined
    ) {
        throw new TypeError(
            "self-managed worker requires an inbound transport connection",
        );
    }

    return {
        ...config,
        auditStorage: resolveAuditStorageLimits(config.auditStorage),
        effectiveSecurityMode: config.effectiveSecurityMode ?? "disabled",
        eventBufferSize: config.eventBufferSize ?? 100,
        handshake: {
            minProtocolVersion: WORKER_PROTOCOL_VERSION,
            maxProtocolVersion: WORKER_PROTOCOL_VERSION,
            clientName: "portable-devshell",
            clientVersion: "0.0.0",
            ...config.handshake,
        },
        managementMode,
        toolScheduler: resolveWorkerToolSchedulerLimits(config.toolScheduler),
    };
}
