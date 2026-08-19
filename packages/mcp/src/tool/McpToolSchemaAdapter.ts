import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

export interface McpTool {
    [key: string]: JsonValue;
    description: string;
    inputSchema: JsonValue;
    name: string;
    outputSchema: JsonValue;
}

export class McpToolSchemaUnavailableError extends Error {
    readonly code = "mcp.toolSchemaUnavailable";

    constructor(toolName: string) {
        super(`Tool schema unavailable for ${toolName}.`);
        this.name = "McpToolSchemaUnavailableError";
    }
}

export class McpToolSchemaAdapter {
    toMcpTool(tool: ToolDefinition, description: string): McpTool {
        if (tool.inputSchema === undefined || tool.outputSchema === undefined) {
            throw new McpToolSchemaUnavailableError(tool.name);
        }

        return {
            description,
            inputSchema: normalizeModelInputSchema(tool.inputSchema),
            name: tool.name,
            outputSchema: normalizeModelSchema(tool.outputSchema)
        };
    }
}

function normalizeModelInputSchema(value: JsonValue): JsonValue {
    const normalized = normalizeModelSchema(value);
    return flattenRootObjectUnion(normalized);
}

function flattenRootObjectUnion(value: JsonValue): JsonValue {
    if (!isRecord(value)) return value;
    const union = Array.isArray(value.anyOf)
        ? value.anyOf
        : Array.isArray(value.oneOf)
            ? value.oneOf
            : undefined;
    if (union === undefined) return value;

    const { anyOf: _anyOf, oneOf: _oneOf, ...base } = value;
    if (isRecord(value.properties)) {
        return base;
    }

    const variants = union.map((variant) => resolveObjectVariant(value, variant));
    if (variants.some((variant) => variant === undefined)) return value;

    const objects = variants as Record<string, JsonValue>[];
    const properties: Record<string, JsonValue> = {};
    for (const variant of objects) {
        const variantProperties = isRecord(variant.properties) ? variant.properties : {};
        Object.assign(properties, variantProperties);
    }

    const required = intersectRequired(objects);
    return {
        ...base,
        ...(objects.every((variant) => variant.additionalProperties === false)
            ? { additionalProperties: false }
            : {}),
        properties,
        ...(required.length === 0 ? {} : { required }),
        type: "object"
    };
}

function normalizeModelSchema(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
        return value.map(normalizeModelSchema);
    }
    if (!isRecord(value)) {
        return value;
    }

    const numeric = isNumericType(value.type);
    const objectWithProperties = isRecord(value.properties);
    const normalized: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (numeric && key === "format") continue;
        if (objectWithProperties && key === "oneOf") continue;
        if (unsupportedModelSchemaKey(key)) continue;
        normalized[key] = normalizeModelSchema(entry);
    }
    return normalized;
}

function unsupportedModelSchemaKey(key: string): boolean {
    return key === "allOf" ||
        key === "not" ||
        key === "dependentRequired" ||
        key === "dependentSchemas" ||
        key === "if" ||
        key === "then" ||
        key === "else" ||
        key === "contains" ||
        key === "minContains" ||
        key === "maxContains";
}

function resolveObjectVariant(
    root: Record<string, JsonValue>,
    value: JsonValue
): Record<string, JsonValue> | undefined {
    if (!isRecord(value)) return undefined;
    const resolved = typeof value.$ref === "string"
        ? resolveLocalDefinition(root, value.$ref)
        : value;
    if (resolved === undefined || (resolved.type !== "object" && !isRecord(resolved.properties))) {
        return undefined;
    }
    return resolved;
}

function resolveLocalDefinition(
    root: Record<string, JsonValue>,
    reference: string
): Record<string, JsonValue> | undefined {
    const prefix = "#/$defs/";
    if (!reference.startsWith(prefix) || !isRecord(root.$defs)) return undefined;
    const definition = root.$defs[reference.slice(prefix.length)];
    return isRecord(definition) ? definition : undefined;
}

function intersectRequired(variants: Record<string, JsonValue>[]): string[] {
    if (variants.length === 0) return [];
    return readRequired(variants[0]).filter((name) =>
        variants.slice(1).every((variant) => readRequired(variant).includes(name))
    );
}

function readRequired(schema: Record<string, JsonValue>): string[] {
    return Array.isArray(schema.required)
        ? schema.required.filter((entry): entry is string => typeof entry === "string")
        : [];
}

function isNumericType(value: JsonValue | undefined): boolean {
    if (value === "integer" || value === "number") {
        return true;
    }
    return Array.isArray(value) && value.some((entry) => entry === "integer" || entry === "number");
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
