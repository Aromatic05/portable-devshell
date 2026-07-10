import type { ApprovalRequest, InstanceEvent, ToolCallRecord } from "@portable-devshell/shared";
import type { InstanceLogEntry } from "../../log/store/LogStoreInstance.js";

import { ApprovalManager, ApprovalStore } from "../../approval/ApprovalInfra.js";
import { InstanceEventBuffer } from "../../log/LogEventBuffer.js";
import { JsonlStore } from "../../log/store/LogStoreJsonl.js";
import { InstanceLogStore } from "../../log/store/LogStoreInstance.js";
import { ToolCallHistory } from "../../log/LogToolCallHistory.js";
import { WorkerCommandClient } from "../../worker/command/WorkerCommandClient.js";
import { WorkerProtocolClient } from "../../worker/protocol/WorkerProtocolClient.js";
import { WorkerRpcBridge } from "../../worker/rpc/WorkerRpcBridge.js";
import { WorkerRpcClient } from "../../worker/rpc/WorkerRpcClient.js";
import { WorkerToolCatalog } from "../tool/WorkerToolCatalog.js";
import { WorkerToolInvoker } from "../tool/WorkerToolInvoker.js";
import { ToolCallScheduler } from "../tool/ToolCallScheduler.js";
import { ToolAllowlist } from "../../tool/ToolAllowlist.js";
import { InstancePaths } from "../../instance/InstancePaths.js";
import { InstanceStateMachine } from "../../instance/state/InstanceStateMachine.js";
import { WorkerInstance } from "./WorkerInstance.js";
import {
    resolveWorkerInstanceConfig,
    type ResolvedWorkerInstanceConfig,
    type WorkerInstanceConfig
} from "./WorkerInstanceConfig.js";

export class WorkerInstanceFactory {
    create(config: WorkerInstanceConfig): WorkerInstance {
        const resolved = resolveWorkerInstanceConfig(config);
        const paths = new InstancePaths(resolved.name, resolved.homeDirectory);
        const allowlist = new ToolAllowlist(resolved.allowTools);
        const catalog = new WorkerToolCatalog(allowlist);
        const rpcBridge = this.#createRpcBridge(resolved);
        const rpcClient = new WorkerRpcClient(rpcBridge);

        return new WorkerInstance({
            catalog,
            commandClient: new WorkerCommandClient(resolved.transport, resolved.name, resolved.env),
            config: resolved,
            eventBuffer: new InstanceEventBuffer(
                resolved.name,
                resolved.eventBufferSize,
                new JsonlStore<InstanceEvent>(paths.eventsFile)
            ),
            logStore: new InstanceLogStore(resolved.name, new JsonlStore<InstanceLogEntry>(paths.logsFile)),
            protocolClient: new WorkerProtocolClient(rpcClient),
            rpcBridge,
            stateMachine: new InstanceStateMachine(resolved.name),
            approvalManager: new ApprovalManager({
                instanceName: resolved.name,
                policy: resolved.approvalPolicy,
                store: new ApprovalStore(new JsonlStore<ApprovalRequest>(paths.approvalsFile)),
                timeout: resolved.approvalTimeout
            }),
            toolCallHistory: new ToolCallHistory(resolved.name, new JsonlStore<ToolCallRecord>(paths.toolCallsFile)),
            toolCallScheduler: new ToolCallScheduler(resolved.toolScheduler),
            toolInvoker: new WorkerToolInvoker(rpcClient, catalog)
        });
    }

    #createRpcBridge(config: ResolvedWorkerInstanceConfig): WorkerRpcBridge {
        return new WorkerRpcBridge({
            transport: config.transport,
            rpcOptions: {
                env: config.env,
                instanceName: config.name
            }
        });
    }
}
