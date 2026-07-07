import { McpToolSchemaUnavailableError } from "../tool/McpToolSchemaAdapter.js";
import { McpEndpointHandlerInitialize, type McpResponseEnvelope } from "./handler/McpEndpointHandlerInitialize.js";
import { McpEndpointHandlerToolsCall } from "./handler/McpEndpointHandlerToolsCall.js";
import { McpEndpointHandlerToolsList } from "./handler/McpEndpointHandlerToolsList.js";
import type { McpEndpointBinding } from "./McpEndpointBinding.js";

type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

interface McpRequestEnvelope {
    id: JsonValue;
    method: string;
    params?: JsonValue;
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class McpEndpointRequestHandler {
    readonly #initializeHandler = new McpEndpointHandlerInitialize();
    readonly #toolsCallHandler = new McpEndpointHandlerToolsCall();
    readonly #toolsListHandler = new McpEndpointHandlerToolsList();

    async handle(binding: McpEndpointBinding, body: JsonValue): Promise<McpResponseEnvelope> {
        const request = this.#parseRequest(body);

        try {
            if (request.method === "initialize") {
                return this.#initializeHandler.handle(binding, request.id);
            }

            if (request.method === "tools/list") {
                return this.#toolsListHandler.handle(binding, request.id);
            }

            if (request.method === "tools/call") {
                return await this.#toolsCallHandler.handle(binding, request.id, request.params ?? {});
            }

            return this.#errorResponse(request.id, -32601, "Method not found.");
        } catch (error) {
            return this.#mapError(request.id, error);
        }
    }

    #parseRequest(body: JsonValue): McpRequestEnvelope {
        if (!isRecord(body) || typeof body.method !== "string" || body.id === undefined) {
            const error = new Error("Invalid MCP request envelope.");
            Object.assign(error, {
                code: "protocol.envelope_invalid",
                details: { body },
                retryable: false
            });
            throw error;
        }

        return {
            id: body.id,
            method: body.method,
            params: body.params
        };
    }

    #mapError(id: JsonValue, error: unknown): McpResponseEnvelope {
        if (error instanceof McpToolSchemaUnavailableError) {
            return this.#errorResponse(id, -32002, error.message, { code: error.code });
        }

        if (typeof error === "object" && error !== null && "code" in error && error.code === "core.instanceNotReady") {
            return this.#errorResponse(id, -32001, "Instance not ready.", { code: "mcp.instanceNotReady" });
        }

        if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
            return this.#errorResponse(id, -32000, error.message);
        }

        return this.#errorResponse(id, -32000, "Unknown MCP error.");
    }

    #errorResponse(id: JsonValue, code: number, message: string, data?: JsonValue): McpResponseEnvelope {
        return {
            jsonrpc: "2.0",
            id,
            error: {
                code,
                data,
                message
            }
        };
    }
}
