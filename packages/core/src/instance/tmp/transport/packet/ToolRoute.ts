import {
    createRemoteError,
    controlErrorCodes,
    isToolCallEvent,
    type ControlPortContext,
    type ControlPortDefinition,
    type InstanceEventRecord,
    type JsonValue,
    type MessageStream,
    type ToolEvent,
} from "@portable-devshell/shared";

import { routeModule } from "../../../Port.js";
import type { WorkerInstance } from "../../index.js";
import {
    limitToolCallResponse,
    readToolCallQuery,
    readToolSessionOpen,
} from "../../../toolcall/Input.js";
import type { ToolCallProvenanceStore } from "../../../toolcall/Provenance.js";
import {
    createToolIngressRouteModule,
    type ToolCallIngressPort,
} from "../../../toolcall/Route.js";

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
        projectEvent?: (
            event: InstanceEventRecord,
        ) => ToolEvent | undefined,
    ): Promise<void>;
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
