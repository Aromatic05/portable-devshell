import {
    routeModule,
    createRemoteError,
    controlErrorCodes,
} from "@portable-devshell/shared";
import type {
    ControlPortContext,
    ControlPortDefinition,
    InstanceEventSource,
    InstanceEventRecord,
    JsonValue,
    MessageStream,
    TaskEvent,
} from "@portable-devshell/shared";
import { isTaskEventType } from "@portable-devshell/shared";
import type { WaitApi } from "../Api.js";

interface WaitTaskRouteSubscriptionPort {
    subscribe(
        stream: MessageStream,
        context: ControlPortContext,
        instanceName: string,
        instance: Pick<InstanceEventSource, "subscribe">,
        fromSeq: number,
        projectEvent?: (event: InstanceEventRecord) => TaskEvent | undefined,
    ): Promise<void>;
}

interface WaitTaskRouteInstancePort {
    events: InstanceEventSource;
    name: string;
    wait: Pick<WaitApi, "list">;
}







export function createWaitTaskRouteModule(
    instance: WaitTaskRouteInstancePort,
    subscriptions: WaitTaskRouteSubscriptionPort,
): ControlPortDefinition {
    return routeModule(
        "task",
        {
            getWaits: async (request) => {
                const payload = request.payload;
                if (!isRecord(payload) || typeof payload.ctxId !== "string" || payload.ctxId.trim().length === 0)
                    throw createRemoteError({
                        code: controlErrorCodes.invalidTarget,
                        message: "task.getWaits requires a Context ID.",
                        retryable: false,
                    });
                const lastSeq = instance.events.cursor();
                return {
                    lastSeq,
                    waits: await instance.wait.list(payload.ctxId.trim()),
                } as unknown as JsonValue;
            },
        },
        {
            subscribe: async (stream, request, context) =>
                await subscriptions.subscribe(
                    stream,
                    context,
                    instance.name,
                    instance.events,
                    readTaskSubscriptionFromSeq(request.payload),
                    (event) =>
                        isTaskEventType(event.type)
                            ? (event as TaskEvent)
                            : undefined,
                ),
        },
    );
}

export function readTaskSubscriptionFromSeq(payload?: JsonValue): number {
    if (
        !isRecord(payload) ||
        typeof payload.fromSeq !== "number" ||
        !Number.isSafeInteger(payload.fromSeq) ||
        payload.fromSeq < 0
    ) {
        throw createRemoteError({
            code: controlErrorCodes.invalidTarget,
            message: "task.subscribe requires a non-negative integer fromSeq.",
            retryable: false,
        });
    }
    return payload.fromSeq;
}

function isRecord(
    value: JsonValue | undefined,
): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
