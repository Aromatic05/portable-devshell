import type { InstanceEvent, ToolCallRecord } from "@portable-devshell/shared";
import type { InstanceLogEntry } from "../../logs/store/InstanceLogStore.js";

import { InstanceEventBuffer } from "../../logs/buffer/InstanceEventBuffer.js";
import { JsonlStore } from "../../logs/store/JsonlStore.js";
import { InstanceLogStore } from "../../logs/store/InstanceLogStore.js";
import { ToolCallHistory } from "../../logs/store/ToolCallHistory.js";
import { WorkerCommandClient } from "../../worker/command/WorkerCommandClient.js";
import { WorkerProtocolClient } from "../../worker/protocol/WorkerProtocolClient.js";
import { WorkerRpcBridge } from "../../worker/rpc/WorkerRpcBridge.js";
import { WorkerRpcClient } from "../../worker/rpc/WorkerRpcClient.js";
import { WorkerToolCatalog } from "../../tools/catalog/WorkerToolCatalog.js";
import { WorkerToolInvoker } from "../../tools/invoker/WorkerToolInvoker.js";
import { ToolAllowlist } from "../../tools/policy/ToolAllowlist.js";
import { InstancePaths } from "../paths/InstancePaths.js";
import { InstanceStateMachine } from "../state/InstanceStateMachine.js";
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
            toolCallHistory: new ToolCallHistory(resolved.name, new JsonlStore<ToolCallRecord>(paths.toolCallsFile)),
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
