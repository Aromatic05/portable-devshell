import type { JsonValue } from "@portable-devshell/shared";

import type { TuiAppState } from "../TuiReducers.js";

export function asRecord(value: unknown): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, JsonValue>) : undefined;
}

export function cloneRecord(value: Record<string, JsonValue>): Record<string, JsonValue> {
    return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
}

export function editorDraft(state: TuiAppState, key: string, fallback: Record<string, JsonValue>): Record<string, JsonValue> {
    return asRecord(state.ui.formDrafts[key]) ?? fallback;
}

export function fieldLine(id: string, label: string, value: JsonValue | undefined): { id: string; text: string } {
    return { id: `field:${id}`, text: `${label.padEnd(18, " ")} [ ${displayValue(value)} ]  (${valueType(value)})` };
}

export function choiceLine(id: string, label: string, value: JsonValue | undefined): { id: string; text: string } {
    return { id: `field:${id}`, text: `${label.padEnd(18, " ")} <${displayValue(value)}>` };
}

export function buttonLine(id: string, label: string, disabled = false): { disabled?: boolean; id: string; text: string; tone: "accent" | "muted" } {
    return { disabled: disabled || undefined, id: `button:${id}`, text: `[ ${label} ]`, tone: disabled ? "muted" : "accent" };
}

export function editorErrorLine(
    state: TuiAppState,
    kind: "config" | "connector",
    boxId: string,
    fieldNames: readonly string[]
): Array<{ id: string; text: string; tone: "danger" }> {
    const editor = state.interaction.editor;
    const error = editor?.kind === kind ? editor.error : undefined;
    if (error === undefined) {
        return [];
    }

    const matchesField = fieldNames.some((field) => error.includes(field));
    if (!matchesField && state.ui.mainFocusId !== boxId) {
        return [];
    }

    return [{ id: `validation-error:${boxId}`, text: `error: ${error}`, tone: "danger" }];
}

export function displayValue(value: JsonValue | undefined): string {
    if (Array.isArray(value)) {
        return value.join(", ");
    }
    if (value === undefined) {
        return "";
    }
    if (typeof value === "object" && value !== null) {
        return JSON.stringify(value);
    }
    return String(value);
}

function valueType(value: JsonValue | undefined): string {
    if (Array.isArray(value)) return "comma-separated list";
    if (value === undefined) return "text";
    if (value === null) return "JSON null";
    if (typeof value === "object") return "JSON";
    return typeof value;
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

export function normalizeDraftForSave(value: Record<string, JsonValue>): Record<string, JsonValue> {
    return normalizeRecord(value);
}

function normalizeRecord(value: Record<string, JsonValue>): Record<string, JsonValue> {
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => {
            if (Array.isArray(entry)) {
                return [key, entry];
            }
            if (typeof entry === "object" && entry !== null) {
                return [key, normalizeRecord(entry as Record<string, JsonValue>)];
            }
            if (typeof entry === "string") {
                if (key === "mode") {
                    const containerMode = containerModeValue(entry);
                    if (containerMode !== undefined) {
                        return [key, containerMode];
                    }
                }
                if (entry === "true" || entry === "false") {
                    return [key, entry === "true"];
                }
                if ((key === "listenPort" || key === "retentionDays" || key === "maxBytes" || key === "eventBufferSize" || key === "maxRunning" || key === "queueDepth" || key === "queueTimeoutMs" || key === "maxRunningPerSession" || key === "queueDepthPerSession") && /^\d+$/.test(entry)) {
                    return [key, Number(entry)];
                }
                if (key === "groups" || key === "capabilities") {
                    return [key, entry.split(",").map((item) => item.trim()).filter((item) => item.length > 0)];
                }
            }
            return [key, entry];
        })
    ) as Record<string, JsonValue>;
}

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
