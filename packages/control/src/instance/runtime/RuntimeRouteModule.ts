import type { WorkerInstance } from "@portable-devshell/core";
import {
    createError,
    errorCodes,
    type ActiveTodoSummary,
    type JsonValue,
    type PrefixRouteModuleDefinition
} from "@portable-devshell/shared";

import { routeModule } from "../../route/ControlRouteFactory.js";
import {
    limitRuntimeLogResponse,
    readRuntimeLogQuery,
    readRuntimeSubscriptionFromSeq
} from "./RuntimeRouteInput.js";
import { RuntimeInteractiveSession } from "./RuntimeInteractiveSession.js";
import type { RuntimeSubscriptionManager } from "./RuntimeSubscriptionManager.js";

export interface RuntimeRouteInstancePort {
    enabled: boolean;
    name: string;
    todoSummaries(): ActiveTodoSummary[];
    worker: Pick<
        WorkerInstance,
        "readLogs" | "refreshStatus" | "snapshot" | "startInteractive" | "stop" | "subscribe"
    >;
}

export interface RuntimeRouteOwnershipPort {
    clearOwned(instanceName: string): void;
    delete(instanceName: string): void;
    markOwned(instanceName: string): void;
}

export function createRuntimeRouteModule(
    instance: RuntimeRouteInstancePort,
    ownership: RuntimeRouteOwnershipPort,
    subscriptions: RuntimeSubscriptionManager
): PrefixRouteModuleDefinition {
    return routeModule("runtime", {
        snapshot: () => {
            const snapshot = withTodoSummaries(instance.worker.snapshot(), instance.todoSummaries());
            return { lastSeq: snapshot.lastSeq, snapshot } as unknown as JsonValue;
        },
        refresh: async () => {
            const snapshot = withTodoSummaries(await instance.worker.refreshStatus(), instance.todoSummaries());
            return { lastSeq: snapshot.lastSeq, snapshot } as unknown as JsonValue;
        },
        start: async (request, context) => {
            if (!instance.enabled) {
                throw createError({
                    code: errorCodes.instanceConflict,
                    details: { instance: instance.name, operation: "start" },
                    message: `Instance ${instance.name} is disabled.`,
                    retryable: false
                });
            }
            const relay = new RuntimeInteractiveSession();
            const stream = await context.openStream(
                { accepted: true },
                {
                    onClose: () => relay.closeInput(),
                    onEvent: (event) => relay.accept(event)
                }
            );
            relay.bindOutput(async (chunk) => await stream.emit("output", { chunk }));
            try {
                const result = withTodoSummaries(
                    await instance.worker.startInteractive(relay),
                    instance.todoSummaries()
                );
                ownership.markOwned(instance.name);
                await stream.complete(result as unknown as JsonValue);
            } finally {
                relay.closeInput();
            }
            return undefined;
        },
        stop: async () => {
            const result = withTodoSummaries(
                await instance.worker.stop(),
                instance.todoSummaries()
            );
            ownership.clearOwned(instance.name);
            if (!instance.enabled) {
                ownership.delete(instance.name);
            }
            return result as unknown as JsonValue;
        },
        readLogs: async (request) => limitRuntimeLogResponse(
            await instance.worker.readLogs(readRuntimeLogQuery(request.payload))
        ) as unknown as JsonValue,
        subscribe: async (request, context) => {
            await subscriptions.subscribe(
                context,
                instance.name,
                instance.worker,
                readRuntimeSubscriptionFromSeq(request.payload)
            );
            return undefined;
        }
    });
}

function withTodoSummaries<T extends { lastSeq: number }>(
    snapshot: T,
    activeTodos: ActiveTodoSummary[]
): T & { activeTodos?: ActiveTodoSummary[] } {
    return { ...snapshot, ...(activeTodos.length === 0 ? {} : { activeTodos }) };
}
