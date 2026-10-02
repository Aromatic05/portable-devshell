// Configuration wire contract for the Control config port. The transport in
// ./Transport.ts is typed against this map, so an operation cannot be called
// with a mismatched request or response shape. `get` is a revisioned snapshot
// and `subscribe` is the cursor-resumable change stream opened in
// ./Transport.ts.

import type { JsonValue } from "../../transport/primitive/JsonValue.js";
import type {
    ConfigBatchUpdateRequest,
    ConfigDraft,
    ConfigUpdateInstanceRequest,
    ConfigUpdateMcpRequest,
    ConfigUpdateWebRequest,
    ConfigView,
} from "./Edit.js";

export const configOperations = {
    get: "get",
    snapshot: "snapshot",
    subscribe: "subscribe",
    update: "update",
    updateInstance: "updateInstance",
    updateMcpEndpoint: "updateMcpEndpoint",
    updateWeb: "updateWeb",
    validate: "validate",
} as const;

/** Authoritative config read: the view and the revision it was read at. */
export interface ConfigSnapshot {
    revision: number;
    view: ConfigView;
}

export interface ConfigSubscriptionRequest {
    fromRevision: number;
}

/** One committed change; `revision` is also the stream sequence. */
export interface ConfigChangeEvent {
    paths: string[];
    revision: number;
}

export interface ConfigContract {
    get: {
        request: undefined;
        response: ConfigView;
    };
    snapshot: {
        request: undefined;
        response: ConfigSnapshot;
    };
    update: {
        request: ConfigBatchUpdateRequest;
        response: ConfigView;
    };
    updateInstance: {
        request: ConfigUpdateInstanceRequest;
        response: ConfigView;
    };
    updateMcpEndpoint: {
        request: ConfigUpdateMcpRequest;
        response: ConfigView;
    };
    updateWeb: {
        request: ConfigUpdateWebRequest;
        response: ConfigView;
    };
    validate: {
        request: ConfigDraft;
        response: ConfigView;
    };
}

export type ConfigOperation = keyof ConfigContract;

export type ConfigRequest<Operation extends ConfigOperation> =
    ConfigContract[Operation]["request"];

export type ConfigResponse<Operation extends ConfigOperation> =
    ConfigContract[Operation]["response"];

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
