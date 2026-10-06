import {
    routeModule,
    createRemoteError,
    controlErrorCodes,
    STREAM_GAP_CODE,
    type ControlPortContext,
    isToolCallEvent,
    type ControlPortDefinition,
    type InstanceEventRecord,
    type JsonValue,
    type MessageStream,
    type ToolCallQuery,
    type ToolCallRecord,
    type ToolDefinition,
    type ToolEvent,
} from "@portable-devshell/shared";

import {
    limitToolCallResponse,
    readToolCallQuery,
    readToolSessionOpen,
} from "./Input.js";
import type {
    ToolCallIngressPort,
    ToolCallProvenanceApi,
} from "../../Api.js";
import {
    createToolIngressRouteModule,
} from "./Route.js";

interface ToolRouteEventPort {
    subscribe(fromSeq?: number):
        | { kind: "events"; events: InstanceEventRecord[]; lastSeq: number }
        | { kind: "gap"; code: typeof STREAM_GAP_CODE; fromSeq: number; lastSeq: number; nextSeq: number };
}

interface ToolRouteInstancePort {
    name?: string;
    worker: {
        readWorkerTools(): Promise<readonly ToolDefinition[]>;
        prepareWorkspace(workspace: string, connectionId: string): Promise<{ workspace: string }>;
        readToolCalls(query: ToolCallQuery): Promise<ToolCallRecord[]>;
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
): ToolRouteEventPort {
    if (worker.subscribe !== undefined)
        return worker as ToolRouteEventPort;
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
