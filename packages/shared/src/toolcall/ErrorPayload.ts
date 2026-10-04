import type { JsonValue } from "../types/Json.js";
import { snapshotJson } from "../types/JsonSnapshot.js";

const payloads = new WeakMap<object, JsonValue>();

export function attachToolCallErrorPayload<T extends Error>(
    error: T,
    payload: JsonValue,
): T {
    payloads.set(error, snapshotJson(payload));
    return error;
}

export function readToolCallErrorPayload(
    error: unknown,
): JsonValue | undefined {
    return typeof error === "object" && error !== null
        ? payloads.get(error)
        : undefined;
}
