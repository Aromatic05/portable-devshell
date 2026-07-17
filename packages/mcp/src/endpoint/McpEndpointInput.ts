import {
    createError,
    errorCodes,
    type ArtifactShareInput,
    type ArtifactTransferCancelInput,
    type ArtifactTransferLookupInput,
    type ArtifactTransferStartInput,
    type ArtifactViewImageInput,
    type JsonValue,
    type ToolDefinition
} from "@portable-devshell/shared";

import type { McpSshInstanceCreateInput } from "../instance/McpInstanceGateway.js";
import { McpToolSchemaUnavailableError } from "../tool/McpToolSchemaAdapter.js";

export function withMcpContextId(tool: ToolDefinition): ToolDefinition {
    return withInputProperty(tool, "ctxId", {
        description: "Session context ID.",
        minLength: 1,
        type: "string"
    }, true);
}

export function readMcpContextInput(input: JsonValue): { ctxId: string; input: JsonValue } {
    if (!isRecord(input) || typeof input.ctxId !== "string" || input.ctxId.trim().length === 0) {
        throw createError({
            code: errorCodes.mcpContextInvalid,
            message: "This tool requires the ctxId returned by environ_info.",
            retryable: false
        });
    }
    const { ctxId, ...toolInput } = input;
    return { ctxId: ctxId.trim(), input: toolInput };
}

export function withMcpInstanceTarget(tool: ToolDefinition): ToolDefinition {
    return withInputProperty(tool, "instance", {
        description: "Managed instance name returned by instance_list.",
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
    return { ...common, path };
}

export function readMcpArtifactShareInput(input: JsonValue): ArtifactShareInput {
    if (!isRecord(input)) {
        throw invalidArguments("artifact_share requires an object input.");
    }
    const handle = optionalString(input.handle, "handle");
    const path = optionalString(input.path, "path");
    if ((handle === undefined) === (path === undefined)) {
        throw invalidArguments("artifact_share requires exactly one of handle or path.");
    }
    const instance = optionalString(input.instance, "instance");
    const expiresInSeconds = input.expiresInSeconds;
    if (expiresInSeconds !== undefined && (typeof expiresInSeconds !== "number" || !Number.isInteger(expiresInSeconds) || expiresInSeconds < 60)) {
        throw invalidArguments("expiresInSeconds must be an integer greater than or equal to 60.");
    }
    const common = {
        ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
        ...(instance === undefined ? {} : { instance })
    };
    if (handle !== undefined) {
        return { ...common, handle };
    }
    if (path === undefined) {
        throw invalidArguments("artifact_share requires path when handle is omitted.");
    }
    return { ...common, path };
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
    if (input.overwrite !== undefined && typeof input.overwrite !== "boolean") {
        throw invalidArguments("overwrite must be a boolean.");
    }
    const common = {
        ...(instance === undefined ? {} : { instance }),
        operation: "start" as const,
        overwrite: input.overwrite === true,
        targetInstance,
        targetPath
    };
    if (handle !== undefined) {
        return { ...common, handle };
    }
    if (sourcePath === undefined) {
        throw invalidArguments("artifact_transfer start requires sourcePath when handle is omitted.");
    }
    return { ...common, sourcePath };
}

export function assertMcpNoArguments(input: JsonValue, toolName: string): void {
    if (!isRecord(input) || Object.keys(input).length !== 0) {
        throw invalidArguments(`${toolName} does not accept arguments.`);
    }
}

export function readMcpInstanceName(input: JsonValue, toolName: string): string {
    if (!isRecord(input) || typeof input.instance !== "string" || input.instance.trim().length === 0) {
        throw invalidArguments(`${toolName} requires instance.`);
    }
    return input.instance.trim();
}

export function readMcpSshCreateInput(input: JsonValue): McpSshInstanceCreateInput {
    if (!isRecord(input)) {
        throw invalidArguments("instance_create requires an object input.");
    }
    const port = input.port;
    if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
        throw invalidArguments("port must be an integer between 1 and 65535.");
    }
    return {
        host: requiredString(input.host, "host"),
        identityFile: optionalString(input.identityFile, "identityFile"),
        name: requiredString(input.name, "name"),
        port: port as number | undefined,
        user: optionalString(input.user, "user"),
        workspace: requiredString(input.workspace, "workspace")
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
    const properties = isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
    const required = Array.isArray(tool.inputSchema.required)
        ? tool.inputSchema.required.filter((entry): entry is string => typeof entry === "string")
        : [];
    return {
        ...tool,
        inputSchema: {
            ...tool.inputSchema,
            properties: { ...properties, [name]: property },
            ...(requiredProperty ? { required: required.includes(name) ? required : [...required, name] } : {})
        }
    };
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

function invalidArguments(message: string) {
    return createError({ code: errorCodes.targetInvalid, message, retryable: false });
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
