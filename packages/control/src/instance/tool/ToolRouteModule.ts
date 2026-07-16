import type { WorkerInstance } from "@portable-devshell/core";
import type { JsonValue, PrefixRouteModuleDefinition } from "@portable-devshell/shared";

import { routeModule } from "../../route/ControlRouteFactory.js";
import {
    readToolApprovalDecision,
    readToolApprovalId,
    readToolCall,
    readToolCallQuery
} from "./ToolRouteInput.js";

export interface ToolRouteInstancePort {
    worker: Pick<
        WorkerInstance,
        "callTool" | "decideApproval" | "getApproval" | "listApprovals" | "readToolCalls"
    >;
}

export function createToolRouteModule(instance: ToolRouteInstancePort): PrefixRouteModuleDefinition {
    return routeModule("tool", {
        call: async (request, context) => {
            const { input, toolName } = readToolCall(request.payload);
            return await instance.worker.callTool(toolName, input, {
                requestId: context.requestId,
                ctxId: context.connectionId,
                source: context.peer
            }) as JsonValue;
        },
        listCalls: async (request) => await instance.worker.readToolCalls(
            readToolCallQuery(request.payload)
        ) as unknown as JsonValue,
        listApprovals: async () => await instance.worker.listApprovals() as unknown as JsonValue,
        getApproval: async (request) => await instance.worker.getApproval(
            readToolApprovalId(request.payload, "tool.getApproval")
        ) as unknown as JsonValue,
        decideApproval: async (request, context) => await instance.worker.decideApproval(
            readToolApprovalId(request.payload, "tool.decideApproval"),
            { ...readToolApprovalDecision(request.payload), decidedBy: context.peer }
        ) as unknown as JsonValue
    });
}
