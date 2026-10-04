import {
    RemoteError,
    createRemoteError,
    controlErrorCodes,
    type ControlPortDefinition,
    type JsonValue,
} from "@portable-devshell/shared";

import { routeModule } from "../Port.js";
import { readToolCallErrorPayload } from "./ErrorPayload.js";
import { readToolCall } from "./Input.js";
import type { ToolCallApi } from "./Runtime.js";

export type ToolCallIngressPort = Pick<ToolCallApi, "call">;

export function createToolIngressRouteModule(
    ingress: ToolCallIngressPort,
): ControlPortDefinition {
    return routeModule(
        "tool",
        {
            call: async (request, context) => {
                const { input, recording, toolName, workspace } = readToolCall(
                    request.payload,
                );
                try {
                    return await ingress.call(
                        context.host,
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
                } catch (error) {
                    return toolCallFailure(error);
                }
            },
        },
        {
            callStream: async (stream, request, context) => {
                const { input, operationId, recording, toolName, workspace } =
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
                        context.host,
                        toolName,
                        input,
                        {
                            requestId: context.requestId,
                            ...(operationId === undefined
                                ? {}
                                : { operationId }),
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
                    result = toolCallFailure(error);
                }
                await sendTail;
                await stream.close(result);
            },
        },
    );
}

function toolCallFailure(error: unknown): JsonValue {
    const failure =
        error instanceof RemoteError
            ? error
            : createRemoteError({
                  code: controlErrorCodes.invalidTarget,
                  message:
                      error instanceof Error ? error.message : String(error),
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

function toolCallErrorComment(error: unknown): { comment?: readonly string[] } {
    const payload = readToolCallErrorPayload(error);
    if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
    )
        return {};
    const comment = payload.comment;
    if (!Array.isArray(comment)) return {};
    const entries = comment.filter(
        (entry): entry is string =>
            typeof entry === "string" && entry.length > 0,
    );
    return entries.length === 0 ? {} : { comment: entries };
}
