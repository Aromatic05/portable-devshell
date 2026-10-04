import {
    controlErrorCodes,
    createRemoteError,
    isMessageEventType,
    type ControlPortContext,
    type ControlPortDefinition,
    type InstanceEventRecord,
    type JsonValue,
    type MessageEvent,
    type MessageStream,
} from "@portable-devshell/shared";
import type { InstanceEventSource } from "../instance/EventBuffer.js";

export interface MessageRouteSubscriptionPort {
    subscribe(
        stream: MessageStream,
        context: ControlPortContext,
        instanceName: string,
        instance: Pick<InstanceEventSource, "subscribe">,
        fromSeq: number,
        projectEvent?: (event: InstanceEventRecord) => MessageEvent | undefined,
    ): Promise<void>;
}

export interface MessageRouteInstancePort {
    events: Pick<InstanceEventSource, "subscribe">;
    name: string;
}

export function createMessageRouteModule(
    instance: MessageRouteInstancePort,
    subscriptions: MessageRouteSubscriptionPort,
): ControlPortDefinition {
    return {
        name: "message",
        operations: [],
        streams: [
            {
                name: "subscribe",
                handle: async (stream, request, context) =>
                    await subscriptions.subscribe(
                        stream,
                        context,
                        instance.name,
                        instance.events,
                        readMessageSubscriptionFromSeq(request.payload),
                        projectMessageEvent,
                    ),
            },
        ],
    };
}

function projectMessageEvent(
    event: InstanceEventRecord,
): MessageEvent | undefined {
    if (isMessageEventType(event.type)) return event as MessageEvent;
    if (
        event.type === "toolCall.completed" &&
        isRecord(event.data) &&
        event.data.toolName === "todo_report"
    ) {
        return { ...event, type: "conversation.changed" };
    }
    return undefined;
}

function readMessageSubscriptionFromSeq(payload?: JsonValue): number {
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
            message:
                "message.subscribe requires a non-negative integer fromSeq.",
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
