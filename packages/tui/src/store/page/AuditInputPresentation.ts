import type { JsonValue } from "@portable-devshell/shared";

import type { BoxLine } from "../../component/ExpandableBox.js";

export function auditInputLines(input: JsonValue | undefined, fallback: string): Array<{ id: string; text: string; tone?: BoxLine["tone"] }> {
    return formatValue(input ?? parseFallback(fallback), 0, undefined).map((text, index) => ({
        id: `input:${index}`,
        text,
        tone: patchLineTone(text)
    }));
}

export function auditInputText(input: JsonValue | undefined, fallback: string): string {
    return formatValue(input ?? parseFallback(fallback), 0, undefined).join("\n");
}

export function auditInputSummary(input: JsonValue | undefined, fallback: string): string {
    const value = input ?? parseFallback(fallback);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return Object.entries(value)
            .slice(0, 3)
            .map(([key, entry]) => `${key}=${summaryValue(entry)}`)
            .join("  ");
    }
    return summaryValue(value);
}

function formatValue(value: JsonValue, depth: number, label: string | undefined): string[] {
    const indent = "  ".repeat(depth);
    const prefix = label === undefined ? "" : `${indent}${label}:`;
    if (typeof value === "string") {
        const lines = value.split(/\r?\n/u);
        return lines.length === 1 ? [`${prefix}${label === undefined ? "" : " "}${value}`] : [prefix, ...lines.map((line) => `${indent}  ${line}`)];
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") {
        return [`${prefix}${label === undefined ? "" : " "}${String(value)}`];
    }
    if (Array.isArray(value)) {
        return [prefix, ...value.flatMap((entry, index) => formatValue(entry, depth + 1, `[${index}]`))];
    }
    return [prefix, ...Object.entries(value).flatMap(([key, entry]) => formatValue(entry, depth + 1, key))];
}

function parseFallback(value: string): JsonValue {
    try {
        return JSON.parse(value) as JsonValue;
    } catch {
        return value;
    }
}

function summaryValue(value: JsonValue): string {
    if (typeof value === "string") {
        return value.replace(/\s+/gu, " ").slice(0, 48);
    }
    if (Array.isArray(value)) {
        return `${value.length} items`;
    }
    if (value !== null && typeof value === "object") {
        return `${Object.keys(value).length} fields`;
    }
    return String(value);
}

function patchLineTone(line: string): BoxLine["tone"] {
    const value = line.trimStart();
    if (value.startsWith("+++") || value.startsWith("+")) {
        return "success";
    }
    if (value.startsWith("---") || value.startsWith("-")) {
        return "danger";
    }
    if (value.startsWith("@@") || value.startsWith("***")) {
        return "accent";
    }
    return undefined;
}
