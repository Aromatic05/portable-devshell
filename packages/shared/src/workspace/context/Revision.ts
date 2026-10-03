import type { JsonValue } from "../../types/Json.js";
import type { McpContextRecord } from "./Model.js";

export interface ContextSnapshot {
    contexts: McpContextRecord[];
    revision: number;
}

export interface ContextChangeEvent {
    ctxIds: string[];
    revision: number;
}

export function readContextSnapshot(value: JsonValue | undefined): ContextSnapshot {
    const record = readRecord(value);
    if (!Array.isArray(record.contexts) || !record.contexts.every(isContextRecord))
        throw new Error("Invalid Context snapshot.");
    return { contexts: record.contexts as unknown as McpContextRecord[], revision: readRevision(record) };
}

export function readContextChangeEvent(value: JsonValue | undefined): ContextChangeEvent {
    const record = readRecord(value);
    if (!Array.isArray(record.ctxIds) || !record.ctxIds.every(ctxId => typeof ctxId === "string"))
        throw new Error("Invalid Context change event.");
    return { ctxIds: record.ctxIds as string[], revision: readRevision(record) };
}

function readRecord(value: JsonValue | undefined): Record<string, JsonValue> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("Invalid Context payload.");
    return value;
}

function readRevision(record: Record<string, JsonValue>): number {
    const revision = record.revision;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
        throw new Error("Invalid Context revision.");
    return revision;
}

function isContextRecord(value: JsonValue): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    return typeof value.ctxId === "string" && typeof value.principal === "string" &&
        typeof value.createdAt === "string" && typeof value.lastAccessedAt === "string" &&
        typeof value.expiresAt === "string" &&
        (value.status === "active" || value.status === "expired" || value.status === "disabled") &&
        Array.isArray(value.environments) && value.environments.every(environment =>
            typeof environment === "object" && environment !== null && !Array.isArray(environment) &&
            typeof environment.instance === "string" &&
            (environment.workspace === undefined || typeof environment.workspace === "string") &&
            (environment.temporaryDirectory === undefined || typeof environment.temporaryDirectory === "string"));
}
