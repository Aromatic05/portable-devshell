import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, isInitializeRequest, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";

import { McpToolSchemaUnavailableError } from "../tool/McpToolSchemaAdapter.js";
import { McpEndpointWorker } from "./McpEndpointWorker.js";

type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

interface CommandResult {
    exitCode: number | null;
    stderr: string;
    stdout: string;
    timedOut?: boolean;
}

interface McpEndpointSession {
    server: Server;
    transport: StreamableHTTPServerTransport;
}

export class McpEndpointBinding {
    readonly #sessions = new Map<string, McpEndpointSession>();
    readonly #worker: McpEndpointWorker;

    constructor(worker: McpEndpointWorker) {
        this.#worker = worker;
    }

    get instanceName(): string {
        return this.#worker.instanceName;
    }

    async close(): Promise<void> {
        const sessions = [...this.#sessions.values()];
        this.#sessions.clear();
        await Promise.all(sessions.map(async (session) => await session.server.close()));
    }

    async handleRequest(request: IncomingMessage, response: ServerResponse, body: JsonValue): Promise<void> {
        const sessionId = asHeaderValue(request.headers["mcp-session-id"]);

        if (sessionId !== undefined) {
            const session = this.#sessions.get(sessionId);

            if (session === undefined) {
                writeJsonRpcError(response, 404, -32001, "Session not found");
                return;
            }

            await session.transport.handleRequest(request, response, body);
            return;
        }

        if (!isInitializeRequest(body)) {
            writeJsonRpcError(response, 400, -32000, "Bad Request: Mcp-Session-Id header is required", getRequestId(body));
            return;
        }

        const session = await this.#createSession();
        await session.transport.handleRequest(request, response, body);
    }

    async #createSession(): Promise<McpEndpointSession> {
        const server = new Server(
            {
                name: "portable-devshell-mcp",
                version: "0.0.0"
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );
        const transport = new StreamableHTTPServerTransport({
            enableJsonResponse: true,
            onsessionclosed: (sessionId) => {
                this.#sessions.delete(sessionId);
            },
            onsessioninitialized: (sessionId) => {
                this.#sessions.set(sessionId, session);
            },
            sessionIdGenerator: () => randomUUID()
        });
        const session: McpEndpointSession = { server, transport };

        this.#registerHandlers(server);
        await server.connect(transport);
        return session;
    }

    #registerHandlers(server: Server): void {
        server.setRequestHandler(ListToolsRequestSchema, async () => {
            try {
                return {
                    tools: this.#worker.listTools()
                };
            } catch (error) {
                throw toMcpError(error);
            }
        });

        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            try {
                const result = await this.#worker.callTool(request.params.name, (request.params.arguments ?? {}) as JsonValue);
                return toCallToolResult(result);
            } catch (error) {
                throw toMcpError(error);
            }
        });
    }
}

function asHeaderValue(value: string | string[] | undefined): string | undefined {
    if (typeof value === "string") {
        return value;
    }

    if (Array.isArray(value) && value.length > 0) {
        return value[0];
    }

    return undefined;
}

function getRequestId(body: JsonValue): string | number | null {
    if (typeof body === "object" && body !== null && !Array.isArray(body) && "id" in body) {
        const id = body.id;

        if (typeof id === "string" || typeof id === "number") {
            return id;
        }
    }

    return null;
}

function writeJsonRpcError(response: ServerResponse, statusCode: number, code: number, message: string, id: string | number | null = null): void {
    response.writeHead(statusCode, { "content-type": "application/json" });
    response.end(
        JSON.stringify({
            error: {
                code,
                message
            },
            id,
            jsonrpc: "2.0"
        })
    );
}

function toCallToolResult(result: CommandResult) {
    return {
        content: [
            {
                type: "text" as const,
                text: result.stdout
            }
        ],
        isError: result.exitCode !== 0
    };
}

function toMcpError(error: unknown): McpError {
    if (error instanceof McpToolSchemaUnavailableError) {
        return new McpError(-32002, error.message, { code: error.code });
    }

    if (typeof error === "object" && error !== null && "code" in error && error.code === "core.instanceNotReady") {
        return new McpError(-32001, "Instance not ready.", { code: "mcp.instanceNotReady" });
    }

    if (error instanceof Error) {
        return new McpError(ErrorCode.ConnectionClosed, error.message);
    }

    return new McpError(ErrorCode.ConnectionClosed, "Unknown MCP error.");
}
