import type { JsonValue } from "../../types/Json.js";
import type { ConfigView } from "./Model.js";

/** Authoritative config read: the view and the revision it was read at. */
export interface ConfigSnapshot {
    revision: number;
    view: ConfigView;
}
/** One committed change; `revision` is also the stream sequence. */
export interface ConfigChangeEvent {
    paths: string[];
    revision: number;
}
export function readConfigSnapshot(
    value: JsonValue | undefined,
): ConfigSnapshot {
    const record = readRecord(value);
    const view = record?.view;
    if (
        view === undefined ||
        typeof view !== "object" ||
        view === null ||
        Array.isArray(view)
    ) {
        throw new Error("Invalid Config snapshot.");
    }
    return {
        revision: readInteger(record, "revision"),
        view: view as unknown as ConfigView,
    };
}
export function readConfigChangeEvent(
    value: JsonValue | undefined,
): ConfigChangeEvent {
    const record = readRecord(value);
    return {
        paths: readStringArray(record, "paths"),
        revision: readInteger(record, "revision"),
    };
}
function readRecord(
    value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function readInteger(
    value: Record<string, JsonValue> | undefined,
    key: string,
): number {
    const candidate = value?.[key];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate))
        throw new Error(`Invalid Config payload ${key}.`);
    return candidate;
}
function readStringArray(
    value: Record<string, JsonValue> | undefined,
    key: string,
): string[] {
    const candidate = value?.[key];
    if (!Array.isArray(candidate) || !candidate.every(isString))
        throw new Error(`Invalid Config event ${key}.`);
    return candidate;
}
function isString(value: JsonValue): value is string {
    return typeof value === "string";
}
