import type { JsonValue } from "@portable-devshell/shared";

import { snapshotJson } from "./boundary/Snapshot.js";

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
