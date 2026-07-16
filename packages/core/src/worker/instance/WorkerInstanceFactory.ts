import type { ApprovalRequest, InstanceEvent, ToolCallAssociation, ToolCallRecord } from "@portable-devshell/shared";
import type { InstanceLogEntry } from "../../log/store/LogStoreInstance.js";

import { ApprovalManager, ApprovalStore } from "../../approval/ApprovalInfra.js";
import { AuditDatabase } from "../../audit/AuditDatabase.js";
import { InstanceEventBuffer } from "../../log/LogEventBuffer.js";
import { InstanceLogStore } from "../../log/store/LogStoreInstance.js";
import { ToolCallHistory } from "../../log/LogToolCallHistory.js";
import { WorkerCommandClient } from "../command/WorkerCommandClient.js";
import { WorkerProtocolClient } from "../protocol/WorkerProtocolClient.js";
import { WorkerRpcBridge } from "../rpc/WorkerRpcBridge.js";
import { WorkerRpcClient } from "../rpc/WorkerRpcClient.js";
import { WorkerToolCatalog } from "../tool/WorkerToolCatalog.js";
import { WorkerToolInvoker } from "../tool/WorkerToolInvoker.js";
import { ToolCallScheduler } from "../tool/ToolCallScheduler.js";
import { InstancePaths } from "../../instance/InstancePaths.js";
import { InstanceStateMachine } from "../../instance/state/InstanceStateMachine.js";
import { WorkerInstance } from "./WorkerInstance.js";
import {
    resolveWorkerInstanceConfig,
    type ResolvedWorkerInstanceConfig,
    type WorkerInstanceConfig
} from "./WorkerInstanceConfig.js";

export class WorkerInstanceFactory {
    create(
        config: WorkerInstanceConfig,
        options: { toolCallAssociationProvider?: () => ToolCallAssociation | undefined } = {}
    ): WorkerInstance {
        const resolved = resolveWorkerInstanceConfig(config);
        const paths = new InstancePaths(resolved.name, resolved.homeDirectory);
        const catalog = new WorkerToolCatalog();
        const rpcBridge = this.#createRpcBridge(resolved);
        const rpcClient = new WorkerRpcClient(rpcBridge);
        const auditDatabase = new AuditDatabase(paths.auditDatabaseFile, resolved.auditStorage);
        const eventStore = auditDatabase.store<InstanceEvent>("events", {
            legacyFile: paths.legacyEventsFile,
            sequence: (record) => record.seq,
            timestamp: (record) => record.at
        });
        const logStore = auditDatabase.store<InstanceLogEntry>("logs", {
            legacyFile: paths.legacyLogsFile,
            sequence: (record) => record.seq,
            timestamp: (record) => record.at
        });
        const approvalStore = auditDatabase.store<ApprovalRequest>("approvals", {
            legacyFile: paths.legacyApprovalsFile,
            timestamp: (record) => record.decision?.decidedAt ?? record.createdAt
        });
        const toolCallStore = auditDatabase.store<ToolCallRecord>("toolCalls", {
            legacyFile: paths.legacyToolCallsFile,
            timestamp: (record) => record.completedAt ?? record.startedAt
        });

        return new WorkerInstance({
            auditDatabase,
            catalog,
            commandClient:
                resolved.transport === undefined
                    ? undefined
                    : new WorkerCommandClient(resolved.transport, resolved.name, resolved.env),
            config: resolved,
            eventBuffer: new InstanceEventBuffer(
                resolved.name,
                resolved.eventBufferSize,
                eventStore
            ),
            logStore: new InstanceLogStore(resolved.name, logStore),
            protocolClient: new WorkerProtocolClient(rpcClient),
            rpcBridge,
            stateMachine: new InstanceStateMachine(resolved.name),
            approvalManager: new ApprovalManager({
                instanceName: resolved.name,
                policy: resolved.approvalPolicy,
                store: new ApprovalStore(approvalStore),
                timeout: resolved.approvalTimeout
            }),
            toolCallAssociationProvider: options.toolCallAssociationProvider,
            toolCallHistory: new ToolCallHistory(resolved.name, toolCallStore),
            toolCallScheduler: new ToolCallScheduler(resolved.toolScheduler),
            toolInvoker: new WorkerToolInvoker(rpcClient, catalog)
        });
    }

    #createRpcBridge(config: ResolvedWorkerInstanceConfig): WorkerRpcBridge {
        const rpcOptions = {
            env: config.env,
            instanceName: config.name
        };

        if (config.managementMode === "selfManaged") {
            return new WorkerRpcBridge({
                connector: config.rpcConnector,
                preservePendingOnDisconnect: true,
                rpcOptions
            });
        }

        return new WorkerRpcBridge({
            transport: config.transport,
            rpcOptions
        });
    }
}
