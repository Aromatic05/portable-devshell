import { createError, errorCodes, type JsonValue } from "@portable-devshell/shared";

import { WorkerRpcClient } from "../../worker/rpc/WorkerRpcClient.js";
import { WorkerToolCatalog } from "./WorkerToolCatalog.js";

export class WorkerToolInvoker {
    readonly #rpcClient: WorkerRpcClient;
    readonly #catalog: WorkerToolCatalog;

    constructor(rpcClient: WorkerRpcClient, catalog: WorkerToolCatalog) {
        this.#rpcClient = rpcClient;
        this.#catalog = catalog;
    }

    async invoke(toolName: string, input: JsonValue): Promise<JsonValue> {
        const tool = this.#catalog.getTool(toolName);

        if (tool === undefined) {
            throw createError({
                code: errorCodes.coreToolSchemaUnavailable,
                message: `Tool ${toolName} is not available for this instance.`,
                retryable: false,
                details: { toolName }
            });
        }

        validateAgainstSchema(tool.inputSchema, input, toolName, "input");
        const result = await this.#rpcClient.request(toolName, input);
        validateAgainstSchema(tool.outputSchema, result, toolName, "output");
        return result;
    }
}

function validateAgainstSchema(schema: JsonValue, value: JsonValue, toolName: string, path: string): void {
    if (!isRecord(schema)) {
        return;
    }

    const expectedType = typeof schema.type === "string" ? schema.type : undefined;

    if (expectedType !== undefined) {
        assertMatchesType(expectedType, value, toolName, path);
    }

    if (expectedType === "object") {
        if (!isRecord(value)) {
            return;
        }

        const required = Array.isArray(schema.required) ? schema.required.filter(isString) : [];
        const properties = isRecord(schema.properties) ? schema.properties : {};

        for (const key of required) {
            if (!(key in value)) {
                throw createError({
                    code: errorCodes.coreToolSchemaUnavailable,
                    message: `Tool ${toolName} input is missing required field ${path}.${key}.`,
                    retryable: false,
                    details: { path: `${path}.${key}`, toolName }
                });
            }
        }

        for (const [key, propertyValue] of Object.entries(value)) {
            if (!(key in properties)) {
                continue;
            }

            validateAgainstSchema(properties[key] as JsonValue, propertyValue, toolName, `${path}.${key}`);
        }
    }

    if (expectedType === "array" && Array.isArray(value) && Array.isArray(schema.items) === false && schema.items !== undefined) {
        for (let index = 0; index < value.length; index += 1) {
            validateAgainstSchema(schema.items as JsonValue, value[index] as JsonValue, toolName, `${path}[${index}]`);
        }
    }
}

function assertMatchesType(expectedType: string, value: JsonValue, toolName: string, path: string): void {
    if (
        (expectedType === "string" && typeof value === "string") ||
        (expectedType === "boolean" && typeof value === "boolean") ||
        (expectedType === "number" && typeof value === "number") ||
        (expectedType === "integer" && Number.isInteger(value)) ||
        (expectedType === "object" && isRecord(value)) ||
        (expectedType === "array" && Array.isArray(value))
    ) {
        return;
    }

    throw createError({
        code: errorCodes.coreToolSchemaUnavailable,
        message: `Tool ${toolName} input field ${path} must be ${expectedType}.`,
        retryable: false,
        details: { expectedType, path, toolName }
    });
}

function isRecord(value: JsonValue | unknown): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function isString(value: unknown): value is string {
    return typeof value === "string";
}
