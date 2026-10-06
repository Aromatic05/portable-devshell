import type { InstanceEventRecord } from "../../client/Stream.js";
import { STREAM_GAP_CODE } from "../../client/Stream.js";
import { controlErrorCodes } from "../../types/Error.js";
import type { JsonValue } from "../../types/Json.js";
import {
    createRemoteError,
    RemoteError,
} from "../../transport/Error.js";
import type { MessageStream } from "../../transport/packet/Stream.js";
import {
    routeModule,
    type ControlHostDefinition,
    type ControlPortContext,
    type ControlPortDefinition,
} from "../../transport/endpoint/route/Control.js";
import type {
    ToolCallIngressPort,
    ToolCallProvenanceApi,
} from "./Api.js";
import {
    isToolCallEvent,
    type ToolCallQuery,
    type ToolCallRecord,
    type ToolEvent,
} from "./Model.js";
import { readToolCallErrorPayload, type ToolDefinition } from "./Type.js";
import {
    limitToolCallResponse,
    readToolCall,
    readToolCallQuery,
    readToolSessionOpen,
} from "./RouteInput.js";

interface ToolRouteEventPort {
    subscribe(fromSeq?: number):
        | { kind: "events"; events: InstanceEventRecord[]; lastSeq: number }
        | {
              kind: "gap";
              code: typeof STREAM_GAP_CODE;
              fromSeq: number;
              lastSeq: number;
              nextSeq: number;
          };
}

interface ToolRouteInstancePort {
    name?: string;
    worker: {
        readWorkerTools(): Promise<readonly ToolDefinition[]>;
        prepareWorkspace(
            workspace: string,
            connectionId: string,
        ): Promise<{ workspace: string }>;
        readToolCalls(query: ToolCallQuery): Promise<ToolCallRecord[]>;
        readToolCallFailureSummary(
            sinceMs: number,
            untilMs: number,
        ): Promise<{ count: number; latest?: ToolCallRecord }>;
        releaseToolSession(connectionId: string): Promise<void>;
    } & Partial<ToolRouteEventPort>;
}

interface ToolRouteSubscriptionPort {
    subscribe(
        stream: MessageStream,
        context: ControlPortContext,
        instanceName: string,
        instance: ToolRouteEventPort,
        fromSeq: number,
        projectEvent?: (event: InstanceEventRecord) => ToolEvent | undefined,
    ): Promise<void>;
}

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

export function createToolIngressHost(
    ingress: ToolCallIngressPort,
): ControlHostDefinition {
    return {
        host: "*",
        ports: [createToolIngressRouteModule(ingress)],
    };
}

export function createToolRouteModule(
    instance: ToolRouteInstancePort,
    provenance?: ToolCallProvenanceApi,
    ingress?: ToolCallIngressPort,
    subscriptions?: ToolRouteSubscriptionPort,
): ControlPortDefinition {
    const local = routeModule(
        "tool",
        {
            openSession: async (request, context) => {
                const prepared = await instance.worker.prepareWorkspace(
                    readToolSessionOpen(request.payload).workspace,
                    context.connectionId,
                );
                return {
                    tools: await instance.worker.readWorkerTools(),
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
            failureSummary: async (request) => {
                const payload = request.payload;
                if (
                    typeof payload !== "object" ||
                    payload === null ||
                    Array.isArray(payload) ||
                    typeof payload.sinceMs !== "number" ||
                    typeof payload.untilMs !== "number" ||
                    !Number.isFinite(payload.sinceMs) ||
                    !Number.isFinite(payload.untilMs)
                ) {
                    throw createRemoteError({
                        code: controlErrorCodes.invalidTarget,
                        message: "tool.failureSummary requires finite sinceMs and untilMs.",
                        retryable: false,
                    });
                }
                return (await instance.worker.readToolCallFailureSummary(
                    payload.sinceMs,
                    payload.untilMs,
                )) as unknown as JsonValue;
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

function toolCallFailure(error: unknown): JsonValue {
    const failure =
        error instanceof RemoteError
            ? error
            : createRemoteError({
                  code: controlErrorCodes.invalidTarget,
                  message: error instanceof Error ? error.message : String(error),
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

function requireSubscriptionWorker(
    worker: ToolRouteInstancePort["worker"],
): ToolRouteEventPort {
    if (worker.subscribe !== undefined) return worker as ToolRouteEventPort;
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
