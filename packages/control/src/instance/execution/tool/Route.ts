import type { WorkerInstance } from "@portable-devshell/core";
import {
    ControlError,
    createError,
    errorCodes,
    type JsonValue,
    type PrefixRouteModuleDefinition,
} from "@portable-devshell/shared";

import { routeModule } from "../../../server/Route.js";
import type { ToolCallProvenanceStore } from "./Provenance.js";
import {
    limitToolCallResponse,
    readToolApprovalDecision,
    readToolApprovalId,
    readToolApprovalListOptions,
    readToolCall,
    readToolCallQuery,
    readToolSessionOpen,
} from "./Input.js";

export interface ToolRouteInstancePort {
    name?: string;
    worker: Pick<
        WorkerInstance,
        | "callTool"
        | "decideApproval"
        | "getApproval"
        | "listApprovals"
        | "listPendingApprovals"
        | "listTools"
        | "prepareWorkspace"
        | "readToolCalls"
        | "releaseToolSession"
    >;
}

export function createToolRouteModule(
    instance: ToolRouteInstancePort,
    provenance?: ToolCallProvenanceStore,
): PrefixRouteModuleDefinition {
    return routeModule("tool", {
        call: async (request, context) => {
            const { input, recording, toolName, workspace } = readToolCall(
                request.payload,
            );
            const feedback: string[] = [];
            const onFeedback = (entries: readonly string[]): void => {
                appendFeedback(feedback, entries);
            };
            try {
                const result = await instance.worker.callTool(
                    toolName,
                    input,
                    {
                        requestId: context.requestId,
                        ctxId: context.connectionId,
                        source: context.peer,
                        workspace,
                    },
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    recording,
                    onFeedback,
                );
                return attachComments(result, feedback);
            } catch (error) {
                const failure =
                    error instanceof ControlError
                        ? error
                        : createError({
                              code: errorCodes.targetInvalid,
                              message:
                                  error instanceof Error
                                      ? error.message
                                      : String(error),
                              retryable: false,
                          });
                return {
                    comment: feedback,
                    error: {
                        code: failure.code,
                        message: failure.message,
                        retryable: failure.retryable,
                    },
                    result: null,
                } as unknown as JsonValue;
            }
        },
        callStream: async (request, context) => {
            const { input, operationId, recording, toolName, workspace } =
                readToolCall(request.payload);
            const controller = new AbortController();
            let closed = false;
            let sendTail = Promise.resolve();
            const stream = await context.openStream(
                { accepted: true },
                {
                    onClose: () => {
                        closed = true;
                        controller.abort(
                            new Error(
                                "Tool progress stream was closed by the client.",
                            ),
                        );
                    },
                },
            );
            const emitProgress = (progress: JsonValue) => {
                if (closed) return;
                sendTail = sendTail
                    .then(async () => {
                        if (!closed) await stream.emit("progress", progress);
                    })
                    .catch((error) => {
                        closed = true;
                        controller.abort(error);
                    });
            };
            const feedback: string[] = [];
            const onFeedback = (entries: readonly string[]): void => {
                appendFeedback(feedback, entries);
            };
            let result: JsonValue;
            try {
                const raw = await instance.worker.callTool(
                    toolName,
                    input,
                    {
                        requestId: context.requestId,
                        ...(operationId === undefined ? {} : { operationId }),
                        ctxId: context.connectionId,
                        source: context.peer,
                        workspace,
                    },
                    controller.signal,
                    undefined,
                    undefined,
                    emitProgress,
                    recording,
                    onFeedback,
                );
                result = attachComments(raw, feedback);
            } catch (error) {
                const failure =
                    error instanceof ControlError
                        ? error
                        : createError({
                              code: errorCodes.targetInvalid,
                              message:
                                  error instanceof Error
                                      ? error.message
                                      : String(error),
                              retryable: false,
                          });
                result = {
                    comment: feedback,
                    error: {
                        code: failure.code,
                        message: failure.message,
                        retryable: failure.retryable,
                    },
                    result: null,
                } as unknown as JsonValue;
            }
            await sendTail;
            if (!closed) await stream.complete(result);
            return undefined;
        },
        openSession: async (request) => {
            const prepared = await instance.worker.prepareWorkspace(
                readToolSessionOpen(request.payload).workspace,
            );
            return {
                tools: instance.worker.listTools(),
                workspace: prepared.workspace,
            } as unknown as JsonValue;
        },
        closeSession: async (_request, context) => {
            await instance.worker.releaseToolSession(context.connectionId);
            return {};
        },
        listCalls: async (request) => {
            const query = readToolCallQuery(request.payload);
            const records = await instance.worker.readToolCalls(query);
            const decorated =
                provenance === undefined || instance.name === undefined
                    ? records
                    : await provenance
                          .decorate(instance.name, records)
                          .catch(() => records);
            return limitToolCallResponse(
                decorated,
                query,
            ) as unknown as JsonValue;
        },
        listApprovals: async (request) => {
            const { pendingOnly } = readToolApprovalListOptions(
                request.payload,
            );
            return (await (pendingOnly
                ? instance.worker.listPendingApprovals()
                : instance.worker.listApprovals())) as unknown as JsonValue;
        },
        getApproval: async (request) =>
            (await instance.worker.getApproval(
                readToolApprovalId(request.payload, "tool.getApproval"),
            )) as unknown as JsonValue,
        decideApproval: async (request, context) =>
            (await instance.worker.decideApproval(
                readToolApprovalId(request.payload, "tool.decideApproval"),
                {
                    ...readToolApprovalDecision(request.payload),
                    decidedBy: context.peer,
                },
            )) as unknown as JsonValue,
    });
}

function appendFeedback(
    target: string[],
    entries: readonly string[],
): void {
    for (const entry of entries) {
        if (!target.includes(entry)) target.push(entry);
    }
}

function attachComments(
    result: JsonValue,
    comments: readonly string[],
): JsonValue {
    if (
        typeof result !== "object" ||
        result === null ||
        Array.isArray(result)
    ) {
        throw new Error(
            "Tool results must be objects when context comments are enabled.",
        );
    }
    return { ...result, comment: [...comments] };
}
