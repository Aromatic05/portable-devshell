import type { JsonValue } from "@portable-devshell/shared";

import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import type { TuiBoxLine } from "../../state/TuiViewModel.js";

type EditableLine = TuiBoxLine & { editable: true; id: string };

export function fieldLine(id: string, label: string, value: JsonValue | undefined): EditableLine {
    return editableLine(id, label, displayValue(value), `  (${valueType(value)})`);
}

export function secretFieldLine(id: string, label: string, value: JsonValue | undefined): EditableLine {
    const configured = typeof value === "string" && value.length > 0;
    return editableLine(id, label, configured ? "********" : "", "  (secret)");
}

export function secretRecordFieldLine(id: string, label: string, value: JsonValue | undefined): EditableLine {
    const keys = typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.keys(value).sort((left, right) => left.localeCompare(right))
        : [];
    return editableLine(id, label, keys.map((key) => `${key}=********`).join(", "), "  (secret JSON)");
}

export function choiceLine(id: string, label: string, value: JsonValue | undefined): EditableLine {
    const choice = displayValue(value);
    const prefix = `${label.padEnd(18, " ")} `;
    const display = choice.length === 0 ? "<empty>" : choice;
    return {
        editable: true,
        editableValue: {
            emptyPlaceholder: "<empty>",
            kind: "choice",
            prefix,
            value: choice,
        },
        id: `field:${id}`,
        text: `${prefix}<${display}>`,
    };
}

export function editableLine(id: string, label: string, value: string, suffix = ""): EditableLine {
    const prefix = `${label.padEnd(18, " ")} `;
    const display = value.length === 0 ? "<empty>" : value;
    return {
        editable: true,
        editableValue: {
            emptyPlaceholder: "<empty>",
            kind: "text",
            prefix,
            suffix,
            value,
        },
        id: `field:${id}`,
        text: `${prefix}${display}${suffix}`,
    };
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
        return value.every((entry) => typeof entry !== "object" || entry === null)
            ? value.join(", ")
            : JSON.stringify(value);
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
