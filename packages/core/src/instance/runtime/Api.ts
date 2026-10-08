import type { Endpoint, InstanceSnapshot, WorkerArtifactApi } from "@portable-devshell/shared";

import type { TransportConnection } from "../transport/endpoint/Connection.js";
import type {
    WorkerAlertsReadResult,
    WorkerExtensionResourcePrepareInput,
    WorkerExtensionResourcePrepareResult,
    WorkerHandshakeResult,
    WorkerWorkspacePrepareResult,
} from "../Api.js";
import type { WorkerTerminal } from "./execution/capability/terminal/Terminal.js";
import type { WorkerTunnel } from "./execution/capability/tunnel/Tunnel.js";
import type { WorkerCommandSessionBridge } from "./execution/Session.js";
import type { WorkerInstanceLifecycle } from "./execution/Lifecycle.js";
import type { WorkerInstanceConnection } from "./supervision/Connection.js";
import type { WorkerOwnership } from "./supervision/Ownership.js";
import type { WorkerInstanceSupervision } from "./supervision/Recovery.js";
import type { WorkerInstanceState } from "./supervision/State.js";

export interface WorkerInstance {
    readonly execution: WorkerExecution;
    readonly provision: WorkerProvision;
    readonly supervision: WorkerSupervision;
}

export interface WorkerExecution {
    readonly artifact: WorkerArtifactApi;
    readonly commandSessions: WorkerCommandSessionBridge;
    readonly environment: WorkerEnvironment;
    readonly terminal: WorkerTerminal;
    readonly tunnel: WorkerTunnel;
}

export interface WorkerEnvironment {
    prepareExtensionResource(
        input: WorkerExtensionResourcePrepareInput,
    ): Promise<WorkerExtensionResourcePrepareResult>;
    prepareWorkspace(workspace: string): Promise<WorkerWorkspacePrepareResult>;
    readAlerts(workspace: string): Promise<WorkerAlertsReadResult>;
    releaseAlerts(workspace: string): Promise<void>;
    touchAlerts(workspace: string): Promise<WorkerAlertsReadResult>;
    touchTemporaryDirectory(path: string): Promise<void>;
}

export interface WorkerProvision {
    readonly reverseConnection?: TransportConnection;
    retireProviderResources(): Promise<void>;
    retireRuntime(): Promise<void>;
}

export interface WorkerSupervision {
    readonly endpoint: Endpoint;
    readonly managementMode: "controllerManaged" | "selfManaged";
    readonly handshake: WorkerHandshakeResult | undefined;
    readonly connection: WorkerInstanceConnection;
    readonly lifecycle: WorkerInstanceLifecycle;
    readonly ownership: WorkerOwnership;
    readonly recovery: WorkerInstanceSupervision;
    readonly state: WorkerInstanceState;
    snapshot(): InstanceSnapshot;
    close(): Promise<void>;
}
