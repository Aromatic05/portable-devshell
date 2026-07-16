import type { JsonValue } from "@portable-devshell/shared";

import type { TuiAppState } from "../reducer/TuiStoreModel.js";

export function asRecord(value: unknown): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, JsonValue>) : undefined;
}

export function cloneRecord(value: Record<string, JsonValue>): Record<string, JsonValue> {
    return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
}

export function editorDraft(state: TuiAppState, key: string, fallback: Record<string, JsonValue>): Record<string, JsonValue> {
    return asRecord(state.ui.formDrafts[key]) ?? fallback;
}

export function readPath(record: Record<string, JsonValue>, path: string): JsonValue | undefined {
    let current: JsonValue | Record<string, JsonValue> | undefined = record;
    for (const segment of path.split(".")) {
        if (typeof current !== "object" || current === null || Array.isArray(current)) {
            return undefined;
        }
        current = current[segment] as JsonValue | undefined;
    }
    return current as JsonValue | undefined;
}

export function setPath(record: Record<string, JsonValue>, path: string, value: JsonValue): Record<string, JsonValue> {
    const copy = cloneRecord(record);
    const segments = path.split(".");
    let current = copy;

    for (const segment of segments.slice(0, -1)) {
        const next = asRecord(current[segment]);
        current[segment] = next === undefined ? {} : cloneRecord(next);
        current = current[segment] as Record<string, JsonValue>;
    }

    current[segments[segments.length - 1]!] = value;
    return copy;
}
