import { Ajv2020, type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import { createError, errorCodes, type JsonValue } from "@portable-devshell/shared";

import { WorkerRpcClient } from "../../worker/rpc/WorkerRpcClient.js";
import { WorkerToolCatalog } from "./WorkerToolCatalog.js";

export class WorkerToolInvoker {
    readonly #rpcClient: WorkerRpcClient;
    readonly #catalog: WorkerToolCatalog;
    readonly #validator = new Ajv2020({ allErrors: true, strict: false });
    readonly #validators = new Map<string, ValidateFunction>();

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

        this.#validate(tool.inputSchema, input, toolName, "input");
        const result = await this.#rpcClient.request(toolName, input);
        this.#validate(tool.outputSchema, result, toolName, "output");
        return result;
    }

    #validate(schema: JsonValue, value: JsonValue, toolName: string, direction: "input" | "output"): void {
        const validator = this.#compile(schema, toolName, direction);

        if (validator(value)) {
            return;
        }

        throw createError({
            code: errorCodes.coreToolSchemaUnavailable,
            message: `Tool ${toolName} returned invalid ${direction}.`,
            retryable: false,
            details: {
                direction,
                errors: formatErrors(validator.errors),
                toolName
            }
        });
    }

    #compile(schema: JsonValue, toolName: string, direction: "input" | "output"): ValidateFunction {
        const key = `${toolName}:${direction}:${JSON.stringify(schema)}`;
        const cached = this.#validators.get(key);

        if (cached !== undefined) {
            return cached;
        }

        try {
            const validator = this.#validator.compile(schema as AnySchema);
            this.#validators.set(key, validator);
            return validator;
        } catch (error) {
            throw createError({
                code: errorCodes.coreToolSchemaUnavailable,
                message: `Tool ${toolName} has an invalid ${direction} schema.`,
                retryable: false,
                details: {
                    direction,
                    reason: error instanceof Error ? error.message : String(error),
                    toolName
                }
            });
        }
    }
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
    return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`);
}
