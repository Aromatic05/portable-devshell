import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

export interface McpTool {
    [key: string]: JsonValue;
    description: string;
    inputSchema: JsonValue;
    name: string;
    outputSchema: JsonValue;
}

export interface McpToolSchemaAdapterOptions {
    hiddenInputProperties?: readonly string[];
    inputHints?: Readonly<Record<string, string>>;
    modelFacing?: boolean;
    preserveInputDescriptions?: boolean;
}

export class McpToolSchemaUnavailableError extends Error {
    readonly code = "mcp.toolSchemaUnavailable";

    constructor(toolName: string) {
        super(`Tool schema unavailable for ${toolName}.`);
        this.name = "McpToolSchemaUnavailableError";
    }
}

const commentOutputSchema: JsonValue = {
    description: "Actionable notes.",
    items: { minLength: 1, type: "string" },
    type: "array",
};

export function withMcpCommentOutputSchema(
    tool: ToolDefinition,
): ToolDefinition {
    if (
        !isRecord(tool.outputSchema) ||
        !isObjectSchemaType(tool.outputSchema.type)
    ) {
        throw new McpToolSchemaUnavailableError(tool.name);
    }
    return {
        ...tool,
        outputSchema: {
            ...tool.outputSchema,
            properties: {
                ...(isRecord(tool.outputSchema.properties)
                    ? tool.outputSchema.properties
                    : {}),
                comment: commentOutputSchema,
            },
        },
    };
}

export class McpToolSchemaAdapter {
    toMcpTool(
        tool: ToolDefinition,
        description: string,
        options: McpToolSchemaAdapterOptions = {},
    ): McpTool {
        if (tool.inputSchema === undefined || tool.outputSchema === undefined) {
            throw new McpToolSchemaUnavailableError(tool.name);
        }

        const modelFacing = options.modelFacing === true;

        return {
            ...(tool._meta === undefined ? {} : { _meta: tool._meta }),
            description,
            inputSchema: modelFacing
                ? compactModelInputSchema(tool.inputSchema, options)
                : normalizeModelInputSchema(tool.inputSchema),
            name: tool.name,
            outputSchema: modelFacing
                ? { type: "object" }
                : normalizeModelSchema(tool.outputSchema),
        };
    }
}

const COMMON_MODEL_INPUT_HINTS: Readonly<Record<string, string>> = {
    ctxId: "Current Context ID.",
    explanation: "Why this call is useful.",
    instance: "Managed instance name.",
    purpose: "Intended outcome.",
};

function compactModelInputSchema(
    value: JsonValue,
    options: McpToolSchemaAdapterOptions,
): JsonValue {
    const normalized = hideModelInputProperties(
        normalizeModelInputSchema(value),
        options.hiddenInputProperties ?? [],
    );
    return pruneUnusedLocalDefinitions(
        compactModelInputDescriptions(
            normalized,
            options.inputHints ?? {},
            undefined,
            options.preserveInputDescriptions === true,
        ),
    );
}

function hideModelInputProperties(
    value: JsonValue,
    hiddenProperties: readonly string[],
): JsonValue {
    if (!isRecord(value) || !isRecord(value.properties)) return value;
    const hidden = new Set(hiddenProperties);
    if (hidden.size === 0) return value;

    const properties = { ...value.properties };
    for (const property of hidden) delete properties[property];
    const required = Array.isArray(value.required)
        ? value.required.filter(
              (entry) => typeof entry !== "string" || !hidden.has(entry),
          )
        : undefined;
    return {
        ...value,
        properties,
        ...(required === undefined ? {} : { required }),
    };
}

function compactModelInputDescriptions(
    value: JsonValue,
    inputHints: Readonly<Record<string, string>>,
    hint?: string,
    preserveDescriptions = false,
): JsonValue {
    if (Array.isArray(value)) {
        return value.map((entry) =>
            compactModelInputDescriptions(
                entry,
                inputHints,
                undefined,
                preserveDescriptions,
            ),
        );
    }
    if (!isRecord(value)) return value;

    const compacted: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (key === "description") {
            if (
                preserveDescriptions &&
                hint === undefined &&
                typeof entry === "string" &&
                entry.length > 0
            )
                compacted.description = entry;
            continue;
        }
        if (key === "$schema" || key === "title") continue;
        if (key === "properties" && isRecord(entry)) {
            compacted.properties = Object.fromEntries(
                Object.entries(entry).map(([propertyName, propertySchema]) => [
                    propertyName,
                    compactModelInputDescriptions(
                        propertySchema,
                        inputHints,
                        modelInputHint(inputHints, propertyName),
                        preserveDescriptions,
                    ),
                ]),
            );
            continue;
        }
        compacted[key] = compactModelInputDescriptions(
            entry,
            inputHints,
            undefined,
            preserveDescriptions,
        );
    }
    return hint === undefined ? compacted : { ...compacted, description: hint };
}

function modelInputHint(
    inputHints: Readonly<Record<string, string>>,
    propertyName: string,
): string | undefined {
    return inputHints[propertyName] ?? COMMON_MODEL_INPUT_HINTS[propertyName];
}

function pruneUnusedLocalDefinitions(value: JsonValue): JsonValue {
    if (!isRecord(value) || !isRecord(value.$defs)) return value;

    const definitions = value.$defs;
    const root = { ...value };
    delete root.$defs;
    const reachable = new Set<string>();
    collectLocalDefinitionReferences(root, reachable);

    const pending = [...reachable];
    for (let index = 0; index < pending.length; index += 1) {
        const name = pending[index];
        if (name === undefined) continue;
        const definition = definitions[name];
        if (definition === undefined) continue;
        const nested = new Set<string>();
        collectLocalDefinitionReferences(definition, nested);
        for (const reference of nested) {
            if (reachable.has(reference)) continue;
            reachable.add(reference);
            pending.push(reference);
        }
    }

    if (reachable.size === 0) return root;
    const kept = Object.fromEntries(
        Object.entries(definitions).filter(([name]) => reachable.has(name)),
    );
    return Object.keys(kept).length === 0 ? root : { ...root, $defs: kept };
}

function collectLocalDefinitionReferences(
    value: JsonValue,
    references: Set<string>,
): void {
    if (Array.isArray(value)) {
        for (const entry of value)
            collectLocalDefinitionReferences(entry, references);
        return;
    }
    if (!isRecord(value)) return;
    if (typeof value.$ref === "string" && value.$ref.startsWith("#/$defs/")) {
        references.add(value.$ref.slice("#/$defs/".length));
    }
    for (const [key, entry] of Object.entries(value)) {
        if (key === "$defs") continue;
        collectLocalDefinitionReferences(entry, references);
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

    const variants = union.map((variant) =>
        resolveObjectVariant(value, variant),
    );
    if (variants.some((variant) => variant === undefined)) return value;

    const objects = variants as Record<string, JsonValue>[];
    const properties: Record<string, JsonValue> = {};
    for (const variant of objects) {
        const variantProperties = isRecord(variant.properties)
            ? variant.properties
            : {};
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
        type: "object",
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
    return (
        key === "allOf" ||
        key === "not" ||
        key === "dependentRequired" ||
        key === "dependentSchemas" ||
        key === "if" ||
        key === "then" ||
        key === "else" ||
        key === "contains" ||
        key === "minContains" ||
        key === "maxContains"
    );
}

function resolveObjectVariant(
    root: Record<string, JsonValue>,
    value: JsonValue,
): Record<string, JsonValue> | undefined {
    if (!isRecord(value)) return undefined;
    const resolved =
        typeof value.$ref === "string"
            ? resolveLocalDefinition(root, value.$ref)
            : value;
    if (
        resolved === undefined ||
        (resolved.type !== "object" && !isRecord(resolved.properties))
    ) {
        return undefined;
    }
    return resolved;
}

function resolveLocalDefinition(
    root: Record<string, JsonValue>,
    reference: string,
): Record<string, JsonValue> | undefined {
    const prefix = "#/$defs/";
    if (!reference.startsWith(prefix) || !isRecord(root.$defs))
        return undefined;
    const definition = root.$defs[reference.slice(prefix.length)];
    return isRecord(definition) ? definition : undefined;
}

function intersectRequired(variants: Record<string, JsonValue>[]): string[] {
    if (variants.length === 0) return [];
    return readRequired(variants[0]).filter((name) =>
        variants
            .slice(1)
            .every((variant) => readRequired(variant).includes(name)),
    );
}

function readRequired(schema: Record<string, JsonValue>): string[] {
    return Array.isArray(schema.required)
        ? schema.required.filter(
              (entry): entry is string => typeof entry === "string",
          )
        : [];
}

function isNumericType(value: JsonValue | undefined): boolean {
    if (value === "integer" || value === "number") {
        return true;
    }
    return (
        Array.isArray(value) &&
        value.some((entry) => entry === "integer" || entry === "number")
    );
}

function isObjectSchemaType(type: JsonValue | undefined): boolean {
    return (
        type === undefined ||
        type === "object" ||
        (Array.isArray(type) && type.includes("object"))
    );
}

function isRecord(
    value: JsonValue | undefined,
): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
