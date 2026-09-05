import {
    createError,
    errorCodes,
    type ArtifactTransferCancelInput,
    type ArtifactTransferLookupInput,
    type ArtifactTransferStartInput,
    type ArtifactViewImageInput,
    type JsonValue,
    type ToolCallProvenance,
    type ToolDefinition
} from "@portable-devshell/shared";

import { McpToolSchemaUnavailableError } from "../tool/McpToolSchemaAdapter.js";

export function withMcpContextId(tool: ToolDefinition): ToolDefinition {
    return withInputProperty(tool, "ctxId", {
        description: "Context ID returned by environ_info in explicit Context mode.",
        minLength: 1,
        type: "string"
    }, true);
}

const MCP_PURPOSE_MAX_LENGTH = 160;
const MCP_EXPLANATION_MAX_LENGTH = 1000;

export function withMcpProvenance(tool: ToolDefinition): ToolDefinition {
    return withInputProperty(
        withInputProperty(tool, "purpose", {
            description: "Briefly state the intended outcome of this tool call. Do not just restate the tool or command.",
            maxLength: MCP_PURPOSE_MAX_LENGTH,
            minLength: 1,
            type: "string"
        }),
        "explanation",
        {
            description: "Optionally state why this tool call is useful now, including relevant observations or prior results.",
            maxLength: MCP_EXPLANATION_MAX_LENGTH,
            minLength: 1,
            type: "string"
        }
    );
}

export function readMcpProvenanceInput(input: JsonValue): {
    input: JsonValue;
    provenance: ToolCallProvenance;
} {
    if (!isRecord(input)) return { input, provenance: {} };
    const hasPurpose = Object.hasOwn(input, "purpose");
    const hasExplanation = Object.hasOwn(input, "explanation");
    if (!hasPurpose && !hasExplanation) return { input, provenance: {} };
    const purpose = optionalBoundedString(input.purpose, "purpose", MCP_PURPOSE_MAX_LENGTH);
    const explanation = optionalBoundedString(input.explanation, "explanation", MCP_EXPLANATION_MAX_LENGTH);
    const { purpose: _purpose, explanation: _explanation, ...toolInput } = input;
    return {
        input: toolInput,
        provenance: {
            ...(explanation === undefined ? {} : { explanation }),
            ...(purpose === undefined ? {} : { purpose })
        }
    };
}

export function readMcpContextInput(input: JsonValue): { ctxId: string; input: JsonValue } {
    const context = readOptionalMcpContextInput(input);
    if (context.ctxId === undefined) {
        throw createError({
            code: errorCodes.mcpContextInvalid,
            message: "No Context is referenced by this request. Call environ_info with workspace or provide ctxId.",
            retryable: false
        });
    }
    return { ctxId: context.ctxId, input: context.input };
}

export function readOptionalMcpContextInput(input: JsonValue): { ctxId?: string; input: JsonValue } {
    if (!isRecord(input) || input.ctxId === undefined) return { input };
    if (typeof input.ctxId !== "string" || input.ctxId.trim().length === 0) {
        throw createError({
            code: errorCodes.mcpContextInvalid,
            message: "ctxId must be a non-empty Context ID.",
            retryable: false
        });
    }
    const { ctxId, ...toolInput } = input;
    return { ctxId: ctxId.trim(), input: toolInput };
}

export function withMcpInstanceTarget(tool: ToolDefinition): ToolDefinition {
    return withInputProperty(tool, "instance", {
        description: "Managed instance name from devshell instance list.",
        minLength: 1,
        type: "string"
    });
}

export function readMcpRoutedInput(
    input: JsonValue,
    instanceRoutingEnabled: boolean,
    defaultInstance: string
): { input: JsonValue; instance: string } {
    if (!isRecord(input)) {
        return { input, instance: defaultInstance };
    }
    const target = input.instance;
    if (target === undefined) {
        return { input, instance: defaultInstance };
    }
    if (!instanceRoutingEnabled) {
        throw invalidArguments("The instance argument is only available when instance management is exposed.");
    }
    if (typeof target !== "string" || target.trim().length === 0) {
        throw invalidArguments("instance must be a non-empty string.");
    }
    const { instance: _ignored, ...workerInput } = input;
    return { input: workerInput, instance: target.trim() };
}

export function readMcpArtifactViewImageInput(input: JsonValue): ArtifactViewImageInput {
    if (!isRecord(input)) {
        throw invalidArguments("artifact_viewImage requires an object input.");
    }
    const handle = optionalString(input.handle, "handle");
    const path = optionalString(input.path, "path");
    if ((handle === undefined) === (path === undefined)) {
        throw invalidArguments("artifact_viewImage requires exactly one of handle or path.");
    }
    const instance = optionalString(input.instance, "instance");
    const common = instance === undefined ? {} : { instance };
    if (handle !== undefined) {
        return { ...common, handle };
    }
    if (path === undefined) {
        throw invalidArguments("artifact_viewImage requires path when handle is omitted.");
    }
    return { ...common, path, workspace: requiredString(input.workspace, "workspace") };
}

export function readMcpArtifactTransferInput(
    input: JsonValue
): ArtifactTransferStartInput | ArtifactTransferLookupInput | ArtifactTransferCancelInput {
    if (!isRecord(input)) {
        throw invalidArguments("artifact_transfer requires an object input.");
    }
    if (input.operation === "status" || input.operation === "cancel") {
        return { operation: input.operation, transferId: requiredString(input.transferId, "transferId") };
    }
    if (input.operation !== "start") {
        throw invalidArguments("artifact_transfer operation must be start, status, or cancel.");
    }
    const handle = optionalString(input.handle, "handle");
    const sourcePath = optionalString(input.sourcePath, "sourcePath");
    if ((handle === undefined) === (sourcePath === undefined)) {
        throw invalidArguments("artifact_transfer start requires exactly one of handle or sourcePath.");
    }
    const instance = optionalString(input.instance, "instance");
    const targetInstance = requiredString(input.targetInstance, "targetInstance");
    const targetPath = requiredString(input.targetPath, "targetPath");
    const targetWorkspace = requiredString(input.targetWorkspace, "targetWorkspace");
    if (input.overwrite !== undefined && typeof input.overwrite !== "boolean") {
        throw invalidArguments("overwrite must be a boolean.");
    }
    const common = {
        ...(instance === undefined ? {} : { instance }),
        operation: "start" as const,
        overwrite: input.overwrite === true,
        targetInstance,
        targetPath,
        targetWorkspace
    };
    if (handle !== undefined) {
        return { ...common, handle };
    }
    if (sourcePath === undefined) {
        throw invalidArguments("artifact_transfer start requires sourcePath when handle is omitted.");
    }
    return {
        ...common,
        sourcePath,
        sourceWorkspace: requiredString(input.sourceWorkspace, "sourceWorkspace")
    };
}

export function readMcpInstanceConnectInput(input: JsonValue): { instance: string; workspace?: string } {
    if (!isRecord(input) || Object.keys(input).some((key) => key !== "instance" && key !== "workspace")) {
        throw invalidArguments("instance_connect accepts only instance and optional workspace.");
    }
    const instance = requiredString(input.instance, "instance");
    const workspace = optionalString(input.workspace, "workspace");
    return workspace === undefined ? { instance } : { instance, workspace };
}

export function readMcpWorkspace(input: JsonValue, toolName: string): string {
    if (!isRecord(input) || Object.keys(input).some((key) => key !== "workspace")) {
        throw invalidArguments(`${toolName} accepts only workspace.`);
    }
    return requiredString(input.workspace, "workspace");
}

export function readMcpEnvironmentInfoInput(
    input: JsonValue,
    options: { allowContextId?: boolean } = {},
): { ctxId?: string; workspace?: string } {
    const allowContextId = options.allowContextId !== false;
    if (!isRecord(input) || Object.keys(input).some((key) => key !== "workspace" && (!allowContextId || key !== "ctxId"))) {
        throw invalidArguments(allowContextId
            ? "environ_info accepts only optional ctxId and workspace."
            : "environ_info accepts only optional workspace when Context authority is externally bound.");
    }
    const ctxId = allowContextId ? optionalString(input.ctxId, "ctxId") : undefined;
    const workspace = optionalString(input.workspace, "workspace");
    return {
        ...(ctxId === undefined ? {} : { ctxId }),
        ...(workspace === undefined ? {} : { workspace })
    };
}

function withInputProperty(
    tool: ToolDefinition,
    name: string,
    property: Record<string, JsonValue>,
    requiredProperty = false
): ToolDefinition {
    if (!isRecord(tool.inputSchema)) {
        throw new McpToolSchemaUnavailableError(tool.name);
    }
    const inputSchema = structuredClone(tool.inputSchema);
    if (!addInputProperty(inputSchema, inputSchema, name, property, requiredProperty)) {
        throw new McpToolSchemaUnavailableError(tool.name);
    }
    return {
        ...tool,
        inputSchema
    };
}

function addInputProperty(
    root: Record<string, JsonValue>,
    schema: Record<string, JsonValue>,
    name: string,
    property: Record<string, JsonValue>,
    requiredProperty: boolean
): boolean {
    if (schema.type === "object" || isRecord(schema.properties)) {
        const properties = isRecord(schema.properties) ? schema.properties : {};
        schema.properties = { ...properties, [name]: property };
        if (requiredProperty) {
            const required = Array.isArray(schema.required)
                ? schema.required.filter((entry): entry is string => typeof entry === "string")
                : [];
            schema.required = required.includes(name) ? required : [...required, name];
        }
        return true;
    }

    const variants = Array.isArray(schema.anyOf)
        ? schema.anyOf
        : Array.isArray(schema.oneOf)
            ? schema.oneOf
            : undefined;
    if (variants === undefined) return false;

    let changed = false;
    for (const variant of variants) {
        if (!isRecord(variant)) continue;
        const target = typeof variant.$ref === "string"
            ? resolveLocalDefinition(root, variant.$ref)
            : variant;
        if (target !== undefined) {
            changed = addInputProperty(root, target, name, property, requiredProperty) || changed;
        }
    }
    return changed;
}

function resolveLocalDefinition(root: Record<string, JsonValue>, reference: string): Record<string, JsonValue> | undefined {
    const prefix = "#/$defs/";
    if (!reference.startsWith(prefix) || !isRecord(root.$defs)) return undefined;
    const definition = root.$defs[reference.slice(prefix.length)];
    return isRecord(definition) ? definition : undefined;
}

function requiredString(value: JsonValue | undefined, field: string): string {
    const normalized = optionalString(value, field);
    if (normalized === undefined) {
        throw invalidArguments(`${field} is required.`);
    }
    return normalized;
}

function optionalString(value: JsonValue | undefined, field: string): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
        throw invalidArguments(`${field} must be a non-empty string.`);
    }
    return value.trim();
}

function optionalBoundedString(value: JsonValue | undefined, field: string, maxLength: number): string | undefined {
    const normalized = optionalString(value, field);
    if (normalized !== undefined && normalized.length > maxLength) {
        throw invalidArguments(`${field} must be at most ${maxLength} characters.`);
    }
    return normalized;
}

function invalidArguments(message: string) {
    return createError({ code: errorCodes.targetInvalid, message, retryable: false });
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
