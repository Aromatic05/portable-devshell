import type { WorkerHandshakeParams } from "../../Api.js";
import {
    WORKER_PROTOCOL_RANGE,
    type ControlInstanceAlertsConfig,
    type EffectiveSecurityMode,
    type InstanceName,
} from "@portable-devshell/shared";

import type { TransportConnection } from "../../transport/endpoint/Connection.js";
import type { WorkerRuntime } from "../execution/Command.js";

export type WorkerManagementMode = "controllerManaged" | "selfManaged";

export const WORKER_GENERATION_RETENTION_DAYS = 7;
export const WORKER_GENERATION_RETENTION_MS =
    WORKER_GENERATION_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

export interface WorkerInstanceConfigCommon {
    alerts?: ControlInstanceAlertsConfig;
    effectiveSecurityMode?: EffectiveSecurityMode;
    name: InstanceName;
    homeDirectory?: string;
    preserveProviderOnRuntimeRetirementFailure?: boolean;
    env?: NodeJS.ProcessEnv;
    handshake?: Partial<WorkerHandshakeParams>;
}

export type WorkerInstanceConfig =
    | (WorkerInstanceConfigCommon & {
          managementMode?: "controllerManaged";
          runtime: WorkerRuntime;
          transportConnection: TransportConnection;
      })
    | (WorkerInstanceConfigCommon & {
          managementMode: "selfManaged";
          runtime?: never;
          transportConnection: TransportConnection;
      });

export interface ResolvedWorkerInstanceConfig extends WorkerInstanceConfigCommon {
    effectiveSecurityMode: EffectiveSecurityMode;
    handshake: WorkerHandshakeParams;
    managementMode: WorkerManagementMode;
    runtime?: WorkerRuntime;
    transportConnection: TransportConnection;
}

export function resolveWorkerInstanceConfig(
    config: WorkerInstanceConfig,
): ResolvedWorkerInstanceConfig {
    const managementMode = config.managementMode ?? "controllerManaged";

    return {
        ...config,
        effectiveSecurityMode: config.effectiveSecurityMode ?? "disabled",
        handshake: {
            protocolRange: WORKER_PROTOCOL_RANGE,
            clientName: "portable-devshell",
            clientVersion: "0.0.0",
            ...config.handshake,
        },
        managementMode,
    };
}
