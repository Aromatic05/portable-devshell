import type { JsonValue, ToolEvent } from "@portable-devshell/shared";

export type ToolCallRecordEventType = ToolEvent["type"] | "log.appended";

export function toEventData(
    record: Record<string, JsonValue | undefined>,
): Record<string, JsonValue> {
    return Object.fromEntries(
        Object.entries(record).filter(([, value]) => value !== undefined),
    ) as Record<string, JsonValue>;
}

