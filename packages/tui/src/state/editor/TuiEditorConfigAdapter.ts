import {
    parseConfigDraft,
    parseConfigInstanceDraft,
    parseConfigInstancePatch,
    parseConfigMcpPatch,
    type ConfigDraft,
    type ConfigInstanceDraft,
    type ConfigInstancePatch,
    type ConfigMcpPatch,
    type JsonValue
} from "@portable-devshell/shared";

import { cloneRecord } from "./TuiEditorDraft.js";

export function coerceTuiEditorRecord(value: Record<string, JsonValue>): Record<string, JsonValue> {
    return coerceRecord(value);
}

export function parseTuiConfigDraft(value: Record<string, JsonValue>): ConfigDraft {
    return parseConfigDraft(coerceTuiEditorRecord(value));
}

export function parseTuiInstanceDraft(value: Record<string, JsonValue>): ConfigInstanceDraft {
    return parseConfigInstanceDraft(stripDerivedInstanceFields(coerceTuiEditorRecord(value)));
}

export function parseTuiInstancePatch(value: Record<string, JsonValue>): ConfigInstancePatch {
    const { name: _name, ...patch } = stripDerivedInstanceFields(coerceTuiEditorRecord(value));
    return parseConfigInstancePatch(patch);
}

export function parseTuiMcpPatch(value: Record<string, JsonValue>): ConfigMcpPatch {
    return parseConfigMcpPatch(coerceTuiEditorRecord(value));
}

export function toTuiInstanceEditorRecord(value: Record<string, JsonValue>): Record<string, JsonValue> {
    return stripDerivedInstanceFields(cloneRecord(value));
}

function stripDerivedInstanceFields(value: Record<string, JsonValue>): Record<string, JsonValue> {
    const draft = cloneRecord(value);
    const security = asRecord(draft.security);
    if (security !== undefined) {
        const { effectiveMode: _effectiveMode, ...persistedSecurity } = security;
        draft.security = persistedSecurity;
    }
    return draft;
}

function coerceRecord(value: Record<string, JsonValue>): Record<string, JsonValue> {
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, coerceValue(key, entry)])
    ) as Record<string, JsonValue>;
}

function coerceValue(key: string, value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
        return value;
    }
    if (typeof value === "object" && value !== null) {
        return coerceRecord(value as Record<string, JsonValue>);
    }
    if (typeof value !== "string") {
        return value;
    }

    const normalizedMode = key === "mode" ? containerModeValue(value) : undefined;
    if (normalizedMode !== undefined) {
        return normalizedMode;
    }
    if (value === "true" || value === "false") {
        return value === "true";
    }
    if (numericFields.has(key) && /^\d+$/u.test(value)) {
        return Number(value);
    }
    if (listFields.has(key)) {
        return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
    }
    return value;
}

const numericFields = new Set([
    "eventBufferSize",
    "listenPort",
    "maxBytes",
    "maxRunning",
    "maxRunningPerSession",
    "queueDepth",
    "queueDepthPerSession",
    "queueTimeoutMs",
    "retentionDays"
]);

const listFields = new Set(["capabilities", "groups"]);

function containerModeValue(value: string): string | undefined {
    switch (value.trim().toLowerCase()) {
        case "distro preset":
            return "preset";
        case "dockerfile":
            return "dockerfile";
        case "compose":
            return "compose";
        case "existing image":
            return "existingImage";
        case "existing stopped container":
            return "existingStoppedContainer";
        default:
            return undefined;
    }
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
