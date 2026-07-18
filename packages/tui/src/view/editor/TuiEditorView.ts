import type { JsonValue } from "@portable-devshell/shared";

import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";

export function fieldLine(id: string, label: string, value: JsonValue | undefined): { id: string; text: string } {
    return { id: `field:${id}`, text: `${label.padEnd(18, " ")} [ ${displayValue(value)} ]  (${valueType(value)})` };
}

export function secretFieldLine(id: string, label: string, value: JsonValue | undefined): { id: string; text: string } {
    const configured = typeof value === "string" && value.length > 0;
    return {
        id: `field:${id}`,
        text: `${label.padEnd(18, " ")} [ ${configured ? "********" : ""} ]  (secret)`
    };
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

