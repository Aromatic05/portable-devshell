import {
    readToolCallErrorPayload,
    type ToolCallPipeline,
    type WorkerInstance,
} from "@portable-devshell/core";
import {
    ControlError,
    createError,
    errorCodes,
    type JsonValue,
    type ControlPortDefinition,
} from "@portable-devshell/shared";

import { routeModule } from "../../../server/Route.js";
import type { ToolCallProvenanceStore } from "./Provenance.js";
import {
    limitToolCallResponse,
    readToolCall,
    readToolCallQuery,
    readToolSessionOpen,
} from "./Input.js";

export interface ToolRouteInstancePort {
    name?: string;
    worker: Pick<
        WorkerInstance,
        | "listTools"
        | "prepareWorkspace"
        | "readToolCalls"
        | "releaseToolSession"
    >;
}

export type ToolCallIngressPort = Pick<ToolCallPipeline, "call">;

export function createControlToolRouteModule(
    ingress: ToolCallIngressPort,
): ControlPortDefinition {
    return routeModule("tool", {
        call: async (request, context) => {
            const { instance, input, recording, toolName, workspace } = readToolCall(
                request.payload,
            );
            try {
                const result = await ingress.call(
                    instance,
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
                );
                return result;
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
                    ...toolCallErrorComment(error),
                    error: {
                        code: failure.code,
                        message: failure.message,
                        retryable: failure.retryable,
                    },
                    result: null,
                } as unknown as JsonValue;
            }
        },
    }, {
        callStream: async (stream, request, context) => {
            const { instance, input, operationId, recording, toolName, workspace } =
                readToolCall(request.payload);
            let sendTail = Promise.resolve();
            const emitProgress = (progress: JsonValue) => {
                sendTail = sendTail.then(() =>
                    stream.send({ name: "progress", payload: progress }),
                );
            };
            let result: JsonValue;
            try {
                result = await ingress.call(
                    instance,
                    toolName,
                    input,
                    {
                        requestId: context.requestId,
                        ...(operationId === undefined ? {} : { operationId }),
                        ctxId: context.connectionId,
                        source: context.peer,
                        workspace,
                    },
                    context.signal,
                    undefined,
                    undefined,
                    emitProgress,
                    recording,
                );
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
                    ...toolCallErrorComment(error),
                    error: {
                        code: failure.code,
                        message: failure.message,
                        retryable: failure.retryable,
                    },
                    result: null,
                } as unknown as JsonValue;
            }
            await sendTail;
            await stream.close(result);
        },
    });
}

export function createToolRouteModule(
    instance: ToolRouteInstancePort,
    provenance?: ToolCallProvenanceStore,
): ControlPortDefinition {
    return routeModule("tool", {
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
    });
}

function toolCallErrorComment(error: unknown): { comment?: readonly string[] } {
    const payload = readToolCallErrorPayload(error);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload))
        return {};
    const comment = payload.comment;
    if (!Array.isArray(comment)) return {};
    const entries = comment.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );
    return entries.length === 0 ? {} : { comment: entries };
}
