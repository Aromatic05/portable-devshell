import type { WorkerInstance } from "@portable-devshell/core";
import { ControlError, createError, errorCodes, type JsonValue, type PrefixRouteModuleDefinition } from "@portable-devshell/shared";

import { routeModule } from "../../route/ControlRouteFactory.js";
import {
    readToolApprovalDecision,
    readToolApprovalId,
    readToolCall,
    readToolCallQuery
} from "./ToolRouteInput.js";
import type { TodoService } from "../todo/TodoService.js";

export interface ToolRouteInstancePort {
    todo: Pick<TodoService, "commentsFor">;
    worker: Pick<
        WorkerInstance,
        "callTool" | "decideApproval" | "getApproval" | "listApprovals" | "readToolCalls"
    >;
}

export function createToolRouteModule(instance: ToolRouteInstancePort): PrefixRouteModuleDefinition {
    return routeModule("tool", {
        call: async (request, context) => {
            const { input, toolName } = readToolCall(request.payload);
            try {
                const result = await instance.worker.callTool(toolName, input, {
                    requestId: context.requestId,
                    ctxId: context.connectionId,
                    source: context.peer
                });
                return { comment: instance.todo.commentsFor(context.connectionId), result } as unknown as JsonValue;
            } catch (error) {
                const failure = error instanceof ControlError ? error : createError({
                    code: errorCodes.targetInvalid,
                    message: error instanceof Error ? error.message : String(error),
                    retryable: false
                });
                return {
                    comment: [...instance.todo.commentsFor(context.connectionId), failure.message],
                    error: { code: failure.code, message: failure.message, retryable: failure.retryable },
                    result: null
                } as unknown as JsonValue;
            }
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
