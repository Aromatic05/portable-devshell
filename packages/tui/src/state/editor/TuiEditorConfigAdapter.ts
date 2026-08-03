import {
    parseConfigDraft,
    parseConfigInstanceDraft,
    parseConfigInstancePatch,
    parseConfigMcpPatch,
    parseConfigWebPatch,
    type ConfigDraft,
    type ConfigInstanceDraft,
    type ConfigInstancePatch,
    type ConfigMcpPatch,
    type ConfigWebPatch,
    type JsonValue
} from "@portable-devshell/shared";

import { cloneRecord } from "./TuiEditorDraft.js";

export function coerceTuiEditorRecord(value: Record<string, JsonValue>): Record<string, JsonValue> {
    return coerceRecord(value);
}

export function parseTuiConfigDraft(value: Record<string, JsonValue>): ConfigDraft {
    const { restartControlRequired: _restartControlRequired, ...draft } = coerceTuiEditorRecord(value);
    return parseConfigDraft(draft);
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

export function parseTuiWebPatch(value: Record<string, JsonValue>): ConfigWebPatch {
    return parseConfigWebPatch(coerceTuiEditorRecord(value));
}

export function toTuiInstanceEditorRecord(value: Record<string, JsonValue>): Record<string, JsonValue> {
    return stripDerivedInstanceFields(cloneRecord(value));
}

export function normalizeTuiInstanceEditorRecord(value: Record<string, JsonValue>): Record<string, JsonValue> {
    return stripDerivedInstanceFields(coerceTuiEditorRecord(value));
}

export function tuiEditorRecordsEqual(
    previous: Record<string, JsonValue>,
    next: Record<string, JsonValue>,
    instance = false,
): boolean {
    const normalize = instance
        ? normalizeTuiInstanceEditorRecord
        : coerceTuiEditorRecord;
    return semanticJson(normalize(previous)) === semanticJson(normalize(next));
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

function semanticJson(value: JsonValue): string {
    if (Array.isArray(value)) {
        return `[${value.map(semanticJson).join(",")}]`;
    }
    if (typeof value === "object" && value !== null) {
        return `{${Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${semanticJson(entry)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
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
    if (jsonFields.has(key) && value.trim().length > 0) {
        try {
            return JSON.parse(value) as JsonValue;
        } catch {
            return value;
        }
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

const jsonFields = new Set(["byTool", "env", "mounts", "rules"]);

const listFields = new Set(["capabilities", "groups", "requiredScopes"]);

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
