import type {
    WorkerExecution as WorkerExecutionApi,
    WorkerInstance as WorkerInstanceApi,
    WorkerProvision as WorkerProvisionApi,
    WorkerSupervision as WorkerSupervisionApi,
} from "./Api.js";
import type { InstanceEventPort } from "../Api.js";
import { createRemoteError, runtimeErrorCodes, type Endpoint } from "@portable-devshell/shared";
import type { WorkerCommandClient } from "./execution/Command.js";
import type { TransportConnection } from "../transport/endpoint/Connection.js";
import { WorkerTunnel } from "./execution/capability/tunnel/Tunnel.js";
import { WorkerCommandSessionBridge } from "./execution/Session.js";
import type { WorkerProtocolClient } from "../transport/packet/Client.js";
import { createWorkerArtifact } from "./execution/capability/artifact/Artifact.js";
import { WorkerEnvironment } from "./execution/capability/environment/Environment.js";
import { WorkerTerminal } from "./execution/capability/terminal/Terminal.js";
import type { InstanceStateMachine } from "./supervision/State.js";
import type { ResolvedWorkerInstanceConfig } from "./provision/Config.js";
import { WorkerInstanceConnection } from "./supervision/Connection.js";
import { WorkerOwnership } from "./supervision/Ownership.js";
import { WorkerInstanceSupervision } from "./supervision/Recovery.js";
import { WorkerInstanceLifecycle } from "./execution/Lifecycle.js";
import { guardArtifact } from "./execution/capability/artifact/Guard.js";
import { ReverseExecution } from "./execution/provider/Reverse.js";
import { WorkerInstanceRetirement } from "./provision/Retirement.js";
import { WorkerInstanceState } from "./supervision/State.js";

interface WorkerInstanceDependencies {
    admission: {
        active(): boolean;
        enabled(): boolean;
    };
    commandClient?: WorkerCommandClient;
    config: ResolvedWorkerInstanceConfig;
    events: InstanceEventPort;
    endpoint: Endpoint;
    onReadyChanged(ready: boolean): Promise<void>;
    protocolClient: WorkerProtocolClient;
    stateMachine: InstanceStateMachine;
    transportConnection: TransportConnection;
}

interface WorkerExecutionComponents {
    readonly commandSessions: WorkerCommandSessionBridge;
    readonly endpoint: Endpoint;
    readonly lifecycle: WorkerInstanceLifecycle;
    readonly protocolClient: WorkerProtocolClient;
    readonly terminal: WorkerTerminal;
    readonly tunnel: WorkerTunnel;
}

export class WorkerInstance implements WorkerInstanceApi {
    readonly execution: WorkerExecutionApi;
    readonly provision: WorkerProvisionApi;
    readonly supervision: WorkerSupervisionApi;

    constructor(dependencies: WorkerInstanceDependencies) {
        const config = dependencies.config;
        const state = new WorkerInstanceState({
            config,
            events: dependencies.events,
            onReadyChanged: dependencies.onReadyChanged,
            stateMachine: dependencies.stateMachine,
        });
        const workerHost = `${config.name}-worker`;
        const protocolClient = dependencies.protocolClient;
        const commandSessions = new WorkerCommandSessionBridge(
            dependencies.endpoint,
            workerHost,
            protocolClient,
        );
        const tunnel = new WorkerTunnel(
            dependencies.endpoint,
            workerHost,
        );
        const terminal = new WorkerTerminal(dependencies.endpoint, workerHost);
        const connection: WorkerInstanceConnection = new WorkerInstanceConnection({
            appendEvent: (type, data) => state.appendEvent(type, data),
            applyStateUpdate: (update) =>
                state.apply(update, connection.snapshotReverse()),
            config,
            protocolClient,
            endpoint: dependencies.endpoint,
            snapshot: () => state.snapshot(connection.snapshotReverse()),
            transportConnection: dependencies.transportConnection,
        });
        const reverse =
            config.managementMode === "selfManaged"
                ? new ReverseExecution({
                      applyStateUpdate: (update) =>
                          state.apply(
                              update,
                              connection.snapshotReverse(),
                          ),
                      connection,
                      name: config.name,
                  })
                : undefined;
        const service = new WorkerInstanceSupervision({
            applyStateUpdate: (update) =>
                state.apply(update, connection.snapshotReverse()),
            commandClient: dependencies.commandClient,
            config,
            connection,
            reverse,
        });
        const lifecycle = new WorkerInstanceLifecycle({
            appendEvent: (type) => state.appendEvent(type),
            applyStateUpdate: (update) =>
                state.apply(update, connection.snapshotReverse()),
            commandClient: dependencies.commandClient,
            config,
            connection,
            refreshStatus: () => service.refreshStatus(),
            reverse,
        });
        const ownership = new WorkerOwnership({
            admission: dependencies.admission,
            instanceName: config.name,
            lifecycle,
            managementMode: config.managementMode,
            recovery: service,
            snapshot: () => state.snapshot(connection.snapshotReverse()),
        });
        const retirement = new WorkerInstanceRetirement({
            commandClient: dependencies.commandClient,
            config,
        });
        const assertReady = () => {
            if (state.snapshot(connection.snapshotReverse()).ready) return;
            throw createRemoteError({
                code: runtimeErrorCodes.instanceNotReady,
                message: `Instance ${config.name} is not ready.`,
                retryable: false,
                details: { instanceName: config.name },
            });
        };
        const artifact = guardArtifact(
            createWorkerArtifact(dependencies.endpoint, workerHost),
            assertReady,
        );
        const environment = new WorkerEnvironment({
            alerts: config.alerts,
            assertReady,
            protocolClient,
        });
        const components: WorkerExecutionComponents = {
            commandSessions,
            endpoint: dependencies.endpoint,
            lifecycle,
            protocolClient,
            terminal,
            tunnel,
        };
        const managementMode = config.managementMode;
        this.execution = { artifact, commandSessions, environment, terminal, tunnel };
        this.provision = {
            reverseConnection:
                managementMode === "selfManaged"
                    ? dependencies.transportConnection
                    : undefined,
            retire: (skipRuntimeRetirement) => retirement.retire(skipRuntimeRetirement),
        };
        this.supervision = {
            endpoint: components.endpoint,
            connection,
            lifecycle,
            ownership,
            recovery: service,
            state,
            get handshake() {
                return connection.handshake;
            },
            get managementMode() {
                return managementMode;
            },
            snapshot: () => state.snapshot(connection.snapshotReverse()),
            close: () => service.close(),
        };
    }

}
