import type { WorkerInstance } from "@portable-devshell/core";
import {
    ControlError,
    createError,
    errorCodes,
    mergeComments,
    resolveErrorHints,
    resolveResultHints,
    toControlErrorBody,
    type JsonValue,
    type PrefixRouteModuleDefinition
} from "@portable-devshell/shared";

import { routeModule } from "../../route/ControlRouteFactory.js";
import type { ToolCallProvenanceStore } from "../../control/tool/ToolCallProvenanceStore.js";
import {
    limitToolCallResponse,
    readToolApprovalDecision,
    readToolApprovalId,
    readToolApprovalListOptions,
    readToolCall,
    readToolCallQuery
} from "./ToolRouteInput.js";

export interface ToolRouteInstancePort {
    name?: string;
    worker: Pick<
        WorkerInstance,
        "callTool" | "decideApproval" | "getApproval" | "listApprovals" | "listPendingApprovals" | "readToolCalls"
    >;
}

export function createToolRouteModule(
    instance: ToolRouteInstancePort,
    provenance?: ToolCallProvenanceStore
): PrefixRouteModuleDefinition {
    return routeModule("tool", {
        call: async (request, context) => {
            const { input, toolName, workspace } = readToolCall(request.payload);
            try {
                const result = await instance.worker.callTool(toolName, input, {
                    requestId: context.requestId,
                    ctxId: context.connectionId,
                    source: context.peer,
                    workspace,
                });
                return attachComments(result, mergeComments([], resolveResultHints(toolName, result)));
            } catch (error) {
                const failure = error instanceof ControlError ? error : createError({
                    code: errorCodes.targetInvalid,
                    message: error instanceof Error ? error.message : String(error),
                    retryable: false
                });
                const body = toControlErrorBody(error);
                const hints = body === undefined ? [] : resolveErrorHints(toolName, body);
                return {
                    comment: mergeComments([], hints),
                    error: { code: failure.code, message: failure.message, retryable: failure.retryable },
                    result: null
                } as unknown as JsonValue;
            }
        },
        listCalls: async (request) => {
            const query = readToolCallQuery(request.payload);
            const records = await instance.worker.readToolCalls(query);
            const decorated = provenance === undefined || instance.name === undefined
                ? records
                : await provenance.decorate(instance.name, records).catch(() => records);
            return limitToolCallResponse(
                decorated,
                query
            ) as unknown as JsonValue;
        },
        listApprovals: async (request) => {
            const { pendingOnly } = readToolApprovalListOptions(request.payload);
            return await (pendingOnly
                ? instance.worker.listPendingApprovals()
                : instance.worker.listApprovals()) as unknown as JsonValue;
        },
        getApproval: async (request) => await instance.worker.getApproval(
            readToolApprovalId(request.payload, "tool.getApproval")
        ) as unknown as JsonValue,
        decideApproval: async (request, context) => await instance.worker.decideApproval(
            readToolApprovalId(request.payload, "tool.decideApproval"),
            { ...readToolApprovalDecision(request.payload), decidedBy: context.peer }
        ) as unknown as JsonValue
    });
}

function attachComments(result: JsonValue, comments: readonly string[]): JsonValue {
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
        throw new Error("Tool results must be objects when context comments are enabled.");
    }
    return { ...result, comment: [...comments] };
}
