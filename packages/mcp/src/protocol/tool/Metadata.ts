import type { JsonValue } from "@portable-devshell/shared";

export interface McpToolAnnotations extends Record<string, JsonValue> {
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
    readOnlyHint: boolean;
}

export function mcpToolAnnotations(meta?: JsonValue): McpToolAnnotations {
    const mcp = mcpMeta(meta);
    const annotations = asRecord(mcp.annotations);
    const readOnlyHint = booleanField(annotations, "readOnlyHint") ?? false;
    return {
        readOnlyHint,
        destructiveHint:
            booleanField(annotations, "destructiveHint") ?? !readOnlyHint,
        idempotentHint:
            booleanField(annotations, "idempotentHint") ?? readOnlyHint,
        openWorldHint: booleanField(annotations, "openWorldHint") ?? true,
    };
}

export function mcpToolTitle(toolName: string, meta?: JsonValue): string {
    return stringField(mcpMeta(meta), "title") ?? humanizeToolName(toolName);
}

export function mcpToolInvocationStatus(
    meta?: JsonValue,
): { invoked: string; invoking: string } | undefined {
    const mcp = mcpMeta(meta);
    const invoked = stringField(mcp, "invoked");
    const invoking = stringField(mcp, "invoking");
    if (invoked !== undefined && invoking !== undefined)
        return { invoked, invoking };
    return undefined;
}

export function mcpToolPreserveInputDescriptions(meta?: JsonValue): boolean {
    return mcpMeta(meta).preserveInputDescriptions === true;
}

export function mcpToolInputHints(
    meta?: JsonValue,
): Readonly<Record<string, string>> {
    const hints = asRecord(mcpMeta(meta).inputHints);
    return Object.fromEntries(
        Object.entries(hints).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
    );
}

export function mcpToolHiddenInputProperties(
    meta?: JsonValue,
): readonly string[] {
    const hidden = mcpMeta(meta).hiddenInputProperties;
    return Array.isArray(hidden)
        ? hidden.filter((entry): entry is string => typeof entry === "string")
        : [];
}

function mcpMeta(meta?: JsonValue): Record<string, JsonValue> {
    return asRecord(asRecord(asRecord(meta).devshell).mcp);
}

function booleanField(
    value: Record<string, JsonValue>,
    field: string,
): boolean | undefined {
    return typeof value[field] === "boolean"
        ? (value[field] as boolean)
        : undefined;
}

function stringField(
    value: Record<string, JsonValue>,
    field: string,
): string | undefined {
    return typeof value[field] === "string" && value[field].length > 0
        ? (value[field] as string)
        : undefined;
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : {};
}

function humanizeToolName(toolName: string): string {
    const words = toolName
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[_\-\s]+/u)
        .filter(Boolean);
    if (words.length === 0) return toolName;
    const text = words.join(" ").toLowerCase();
    return text[0]!.toUpperCase() + text.slice(1);
}
