import {
    Endpoint,
    type InstanceEvent,
} from "@portable-devshell/shared";
import type { InstanceLogEntry } from "../../storage/log/Store.js";

import { ApprovalManager, ApprovalStore } from "../../approval/Manager.js";
import { AuditDatabase } from "../../storage/audit/database/Database.js";
import { InstanceEventBuffer } from "../../instance/EventBuffer.js";
import { LogStoreInstance } from "../../storage/log/Store.js";
import { AuditToolCallHistory } from "../../storage/audit/ToolCallHistory.js";
import { WorkerCommandClient } from "../transport/command/Client.js";
import { WorkerProtocolClient } from "../protocol/Client.js";
import { WorkerToolCatalog } from "../tool/Catalog.js";
import { WorkerToolInvoker } from "../tool/Invoker.js";
import { WorkerToolCallScheduler } from "../tool/Scheduler.js";
import { WorkerTerminalClient } from "../protocol/Terminal.js";
import { WorkerTransportConnection } from "../transport/Transport.js";
import { InstancePaths } from "../../instance/Paths.js";
import { InstanceStateMachine } from "../../instance/state/Machine.js";
import { WorkerInstance } from "./Instance.js";
import {
    resolveWorkerInstanceConfig,
    type ResolvedWorkerInstanceConfig,
    type WorkerInstanceConfig,
} from "./Config.js";

export class WorkerInstanceFactory {
    create(config: WorkerInstanceConfig): WorkerInstance {
        const resolved = resolveWorkerInstanceConfig(config);
        const paths = new InstancePaths(resolved.name, resolved.homeDirectory);
        const catalog = new WorkerToolCatalog();
        const transportConnection = this.#createTransportConnection(resolved);
        const workerHost = `${resolved.name}-worker`;
        const endpoint = new Endpoint({
            host: resolved.name,
            connectChannel: (signal) => transportConnection.connect(signal),
        });
        const protocolClient = new WorkerProtocolClient(endpoint, workerHost);
        const auditDatabase = new AuditDatabase(
            paths.auditDatabaseFile,
            resolved.auditStorage,
        );
        const eventStore = auditDatabase.store<InstanceEvent>("events", {
            legacyFile: paths.legacyEventsFile,
            maxRecords: resolved.eventBufferSize,
            sequence: (record) => record.seq,
            timestamp: (record) => record.at,
        });
        const logStore = auditDatabase.store<InstanceLogEntry>("logs", {
            legacyFile: paths.legacyLogsFile,
            sequence: (record) => record.seq,
            timestamp: (record) => record.at,
        });
        const approvalStore = auditDatabase.approvalStore({
            legacyFile: paths.legacyApprovalsFile,
            timestamp: (record) =>
                record.decision?.decidedAt ?? record.createdAt,
        });
        const toolCallStore = auditDatabase.toolCallStore({
            legacyFile: paths.legacyToolCallsFile,
            timestamp: (record) => record.completedAt ?? record.startedAt,
        });

        return new WorkerInstance({
            auditDatabase,
            catalog,
            commandClient:
                resolved.transport === undefined
                    ? undefined
                    : new WorkerCommandClient(
                          resolved.transport,
                          resolved.name,
                          resolved.env,
                      ),
            config: resolved,
            eventBuffer: new InstanceEventBuffer(
                resolved.name,
                resolved.eventBufferSize,
                eventStore,
            ),
            logStore: new LogStoreInstance(resolved.name, logStore),
            protocolClient,
            endpoint,
            stateMachine: new InstanceStateMachine(resolved.name),
            approvalManager: new ApprovalManager({
                instanceName: resolved.name,
                policy: resolved.approvalPolicy,
                store: new ApprovalStore(approvalStore),
                timeout: resolved.approvalTimeout,
            }),
            toolCallHistory: new AuditToolCallHistory(
                resolved.name,
                toolCallStore,
            ),
            terminalClient: new WorkerTerminalClient(endpoint, workerHost),
            transportConnection,
            toolCallScheduler: new WorkerToolCallScheduler(
                resolved.toolScheduler,
            ),
            toolInvoker: new WorkerToolInvoker(endpoint, workerHost, catalog),
        });
    }

    #createTransportConnection(
        config: ResolvedWorkerInstanceConfig,
    ): WorkerTransportConnection {
        if (config.managementMode === "selfManaged") {
            return config.transportConnection!;
        }
        return WorkerTransportConnection.fromTransport(config.transport!, {
            env: config.env,
            instanceName: config.name,
        });
    }

}