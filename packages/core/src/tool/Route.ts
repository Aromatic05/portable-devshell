import {
    RemoteError,
    createRemoteError,
    controlErrorCodes,
    isToolCallEvent,
    type ControlPortContext,
    type ControlPortDefinition,
    type JsonValue,
    type InstanceEventRecord,
    type MessageStream,
    type ToolEvent,
} from "@portable-devshell/shared";

import { routeModule } from "../Port.js";
import type { WorkerInstance } from "../worker/instance/Instance.js";
import { readToolCallErrorPayload } from "./ErrorPayload.js";
import {
    limitToolCallResponse,
    readToolCall,
    readToolCallQuery,
    readToolSessionOpen,
} from "./Input.js";
import type { ToolCallPipeline } from "./Pipeline.js";
import type { ToolCallProvenanceStore } from "./Provenance.js";

export interface ToolRouteInstancePort {
    name?: string;
    worker: Pick<
        WorkerInstance,
        | "listTools"
        | "prepareWorkspace"
        | "readToolCalls"
        | "releaseToolSession"
    > &
        Partial<Pick<WorkerInstance, "subscribe">>;
}

export interface ToolRouteSubscriptionPort {
    subscribe(
        stream: MessageStream,
        context: ControlPortContext,
        instanceName: string,
        instance: Pick<WorkerInstance, "subscribe">,
        fromSeq: number,
        projectEvent?: (event: InstanceEventRecord) => ToolEvent | undefined,
    ): Promise<void>;
}

export type ToolCallIngressPort = Pick<ToolCallPipeline, "call">;

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

export function createToolRouteModule(
    instance: ToolRouteInstancePort,
    provenance?: ToolCallProvenanceStore,
    ingress?: ToolCallIngressPort,
    subscriptions?: ToolRouteSubscriptionPort,
): ControlPortDefinition {
    const local = routeModule(
        "tool",
        {
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
        },
        {
            ...(subscriptions === undefined
                ? {}
                : {
                      subscribe: async (stream, request, context) =>
                          await subscriptions.subscribe(
                              stream,
                              context,
                              requireInstanceName(instance),
                              requireSubscriptionWorker(instance.worker),
                              readToolSubscriptionFromSeq(request.payload),
                              (event) =>
                                  isToolCallEvent(event.type)
                                      ? (event as ToolEvent)
                                      : undefined,
                          ),
                  }),
        },
    );
    if (ingress === undefined) return local;
    const ingressRoute = createToolIngressRouteModule(ingress);
    return {
        name: "tool",
        operations: [...ingressRoute.operations, ...local.operations],
        streams: [...(ingressRoute.streams ?? []), ...(local.streams ?? [])],
    };
}

function requireSubscriptionWorker(
    worker: ToolRouteInstancePort["worker"],
): Pick<WorkerInstance, "subscribe"> {
    if (worker.subscribe !== undefined)
        return worker as Pick<WorkerInstance, "subscribe">;
    throw createRemoteError({
        code: controlErrorCodes.invalidTarget,
        message: "Tool event subscription is unavailable for this instance.",
        retryable: false,
    });
}

function readToolSubscriptionFromSeq(payload?: JsonValue): number {
    if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload) ||
        typeof payload.fromSeq !== "number" ||
        !Number.isSafeInteger(payload.fromSeq) ||
        payload.fromSeq < 0
    ) {
        throw createRemoteError({
            code: controlErrorCodes.invalidTarget,
            message: "tool.subscribe requires a non-negative integer fromSeq.",
            retryable: false,
        });
    }
    return payload.fromSeq;
}

function requireInstanceName(instance: ToolRouteInstancePort): string {
    if (instance.name !== undefined) return instance.name;
    throw createRemoteError({
        code: controlErrorCodes.invalidTarget,
        message: "tool call requires an instance route.",
        retryable: false,
    });
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
