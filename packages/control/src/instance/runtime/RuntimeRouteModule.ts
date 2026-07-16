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
    readRuntimeSubscriptionFromSeq,
    readRuntimeWorkspacePath
} from "./RuntimeRouteInput.js";
import { RuntimeInteractiveSession } from "./RuntimeInteractiveSession.js";
import type { RuntimeSubscriptionManager } from "./RuntimeSubscriptionManager.js";

export interface RuntimeRouteInstancePort {
    enabled: boolean;
    name: string;
    todoSummary(): ActiveTodoSummary | undefined;
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
            const snapshot = withTodoSummary(instance.worker.snapshot(), instance.todoSummary());
            return { lastSeq: snapshot.lastSeq, snapshot } as unknown as JsonValue;
        },
        refresh: async () => {
            const snapshot = withTodoSummary(await instance.worker.refreshStatus(), instance.todoSummary());
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
                const result = await instance.worker.startInteractive(readRuntimeWorkspacePath(request.payload), relay);
                ownership.markOwned(instance.name);
                await stream.complete(result as unknown as JsonValue);
            } finally {
                relay.closeInput();
            }
            return undefined;
        },
        stop: async () => {
            const result = await instance.worker.stop();
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

function withTodoSummary<T extends { lastSeq: number }>(
    snapshot: T,
    activeTodo: ActiveTodoSummary | undefined
): T & { activeTodo?: ActiveTodoSummary } {
    return { ...snapshot, ...(activeTodo === undefined ? {} : { activeTodo }) };
}
