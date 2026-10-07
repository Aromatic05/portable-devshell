import { ExtensionError } from "@portable-devshell/extension";
import type { JsonValue, MessageEvent } from "@portable-devshell/shared";
import {
    type ControlStreamBinding,
} from "@portable-devshell/extension/control";
import type {
    ExtensionInstanceEvent,
    ExtensionInstanceObserveCapability,
} from "@portable-devshell/extension/instance";

export function createMessageSubscriptionBinding(
    observe: Pick<ExtensionInstanceObserveCapability, "watchEvents">,
): ControlStreamBinding {
    return async (stream, request, context) => {
        let nextSeq = readMessageSubscriptionFromSeq(request.payload);
        await observe.watchEvents(context.destination, {
            fromSeq: nextSeq,
            onSeed: async (seed) => {
                nextSeq = seed.lastSeq + 1;
                await stream.send({
                    name: "seed",
                    payload: {
                        events: seed.events.flatMap((event) => {
                            const projected = projectMessageEvent(event);
                            return projected === undefined ? [] : [projected];
                        }) as unknown as JsonValue,
                        lastSeq: seed.lastSeq,
                    },
                });
            },
            onEvent: async (event) => {
                nextSeq = event.seq + 1;
                const projected = projectMessageEvent(event);
                if (projected !== undefined)
                    await stream.send({ name: "event", payload: projected as unknown as JsonValue, seq: projected.seq });
            },
            onGap: async (gap) => {
                await stream.send({
                    name: "gap",
                    payload: {
                        instance: context.destination,
                        latestSeq: gap.lastSeq,
                        oldestAvailableSeq: gap.nextSeq,
                        requestedFromSeq: nextSeq,
                    },
                    seq: gap.lastSeq,
                });
                nextSeq = gap.nextSeq;
            },
            signal: context.signal,
        });
    };
}

function projectMessageEvent(
    event: ExtensionInstanceEvent,
): MessageEvent | undefined {
    if (isMessageEventType(event.type)) return event as unknown as MessageEvent;
    if (
        event.type === "toolCall.completed" &&
        isRecord(event.data) &&
        event.data.toolName === "todo_report"
    ) {
        return { ...event, type: "message.changed" } as unknown as MessageEvent;
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
        throw new ExtensionError({
            code: "control.invalidTarget",
            message:
                "message.subscribe requires a non-negative integer fromSeq.",
            retryable: false,
        });
    }
    return payload.fromSeq;
}

function isMessageEventType(type: string): boolean {
    return type.startsWith("context.message.") || type === "message.changed";
}

function isRecord(
    value: JsonValue | undefined,
): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
