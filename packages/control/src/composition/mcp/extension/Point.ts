import type {
    ExtensionJsonValue,
    ExtensionPointDeclaration,
} from "@portable-devshell/extension";
import {
    tools,
    type McpToolActivity,
    type McpToolDeclaration,
} from "@portable-devshell/extension/mcp";

import type {
    ExtensionPointDefinition,
    ExtensionPointValidationContext,
} from "../../../control/extension/generation/registration/PointRegistry.js";
import {
    createMcpToolSandboxBinding,
    validateMcpToolBinding,
} from "./Sandbox.js";

export const mcpToolsExtensionPointDefinition: ExtensionPointDefinition =
    Object.freeze({
        createSandboxBinding: createMcpToolSandboxBinding,
        id: tools.id,
        parseDeclaration: parseMcpToolDeclaration,
        validateBinding(
            binding: unknown,
            context: ExtensionPointValidationContext,
        ) {
            validateMcpToolBinding(binding, context);
        },
    });

function parseMcpToolDeclaration(
    value: ExtensionPointDeclaration,
): McpToolDeclaration {
    const record = value as ExtensionPointDeclaration &
        Record<string, ExtensionJsonValue | undefined>;
    const allowed = new Set([
        "activity",
        "description",
        "destructiveHint",
        "id",
        "idempotentHint",
        "inputSchema",
        "invoked",
        "invoking",
        "openWorldHint",
        "outputSchema",
        "readOnlyHint",
        "title",
    ]);
    const unknown = Object.keys(record).find((key) => !allowed.has(key));
    if (unknown !== undefined)
        throw new TypeError(
            tools.id + " declaration has unknown field " + unknown + ".",
        );
    if (!/^[a-z0-9]+_[A-Za-z0-9]+$/u.test(value.id)) {
        throw new TypeError(
            tools.id + " declaration id must be a canonical MCP tool name.",
        );
    }
    return Object.freeze({
        id: value.id,
        description: readString(record.description, "description"),
        inputSchema: readSchema(record.inputSchema, "inputSchema"),
        outputSchema: readSchema(record.outputSchema, "outputSchema"),
        ...(record.activity === undefined
            ? {}
            : { activity: readActivity(record.activity) }),
        ...optionalString(record, "title"),
        ...optionalString(record, "invoking"),
        ...optionalString(record, "invoked"),
        ...optionalBoolean(record, "readOnlyHint"),
        ...optionalBoolean(record, "destructiveHint"),
        ...optionalBoolean(record, "idempotentHint"),
        ...optionalBoolean(record, "openWorldHint"),
    });
}

function readString(
    value: ExtensionJsonValue | undefined,
    field: string,
): string {
    if (typeof value === "string" && value.length > 0 && value.trim() === value)
        return value;
    throw new TypeError(
        tools.id +
            " declaration " +
            field +
            " must be a non-empty trimmed string.",
    );
}

function optionalString(
    record: Record<string, ExtensionJsonValue | undefined>,
    field: "invoked" | "invoking" | "title",
): Partial<Record<typeof field, string>> {
    const value = record[field];
    return value === undefined ? {} : { [field]: readString(value, field) };
}

function optionalBoolean(
    record: Record<string, ExtensionJsonValue | undefined>,
    field:
        | "destructiveHint"
        | "idempotentHint"
        | "openWorldHint"
        | "readOnlyHint",
): Partial<Record<typeof field, boolean>> {
    const value = record[field];
    if (value === undefined) return {};
    if (typeof value !== "boolean")
        throw new TypeError(
            tools.id + " declaration " + field + " must be a boolean.",
        );
    return { [field]: value };
}

function readSchema(
    value: ExtensionJsonValue | undefined,
    field: string,
): ExtensionJsonValue {
    if (
        typeof value === "boolean" ||
        (typeof value === "object" && value !== null && !Array.isArray(value))
    )
        return value;
    throw new TypeError(
        tools.id +
            " declaration " +
            field +
            " must be a JSON Schema object or boolean.",
    );
}

function readActivity(value: ExtensionJsonValue): McpToolActivity {
    if (
        value === "execution" ||
        value === "mutation" ||
        value === "observation" ||
        value === "wait"
    )
        return value;
    throw new TypeError(
        tools.id +
            " declaration activity must be execution, mutation, observation, or wait.",
    );
}
