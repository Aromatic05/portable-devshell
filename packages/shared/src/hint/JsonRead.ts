import type { JsonValue } from "../type/TypeJsonValue.js";

export function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, JsonValue>;
    }
    return undefined;
}

export function asString(value: JsonValue | undefined): string | undefined {
    return typeof value === "string" ? value : undefined;
}

export function asNumber(value: JsonValue | undefined): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: JsonValue | undefined): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

export function asArray(value: JsonValue | undefined): JsonValue[] | undefined {
    return Array.isArray(value) ? value : undefined;
}
