import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, isInitializeRequest, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { toControlErrorBody, type ControlErrorBody, type JsonValue } from "@portable-devshell/shared";

import { McpToolSchemaUnavailableError } from "../tool/McpToolSchemaAdapter.js";
import { McpEndpointWorker } from "../endpoint/McpEndpointWorker.js";

interface McpEndpointSession {
    server: Server;
    transport: StreamableHTTPServerTransport;
}

export class McpEndpointBinding {
    readonly #requestSignals = new Map<string, AbortController>();
    readonly #sessions = new Map<string, McpEndpointSession>();
    readonly #worker: McpEndpointWorker;

    constructor(worker: McpEndpointWorker) {
        this.#worker = worker;
    }

    get instanceName(): string {
        return this.#worker.instanceName;
    }

    async close(): Promise<void> {
        const sessions = [...this.#sessions.entries()];
        await Promise.all(
            sessions.map(async ([sessionId, session]) => {
                await session.server.close();
                await this.#closeSession(sessionId);
            })
        );
    }

    async handleRequest(request: IncomingMessage, response: ServerResponse, body: JsonValue): Promise<void> {
        const sessionId = asHeaderValue(request.headers["mcp-session-id"]);

        if (sessionId !== undefined) {
            const session = this.#sessions.get(sessionId);

            if (session === undefined) {
                writeJsonRpcError(response, 404, -32001, "Session not found");
                return;
            }

            await this.#handleSessionRequest(sessionId, session, request, response, body);
            return;
        }

        if (!isInitializeRequest(body)) {
            writeJsonRpcError(response, 400, -32000, "Bad Request: Mcp-Session-Id header is required", getRequestId(body));
            return;
        }

        const session = await this.#createSession();
        await session.transport.handleRequest(request, response, body);
    }

    async #handleSessionRequest(
        sessionId: string,
        session: McpEndpointSession,
        request: IncomingMessage,
        response: ServerResponse,
        body: JsonValue
    ): Promise<void> {
        const requestId = getRequestId(body);
        if (requestId === null) {
            await session.transport.handleRequest(request, response, body);
            return;
        }

        const key = requestSignalKey(sessionId, String(requestId));
        const controller = new AbortController();
        const abortRequest = () => controller.abort("MCP HTTP request was aborted");
        const closeResponse = () => {
            if (!response.writableEnded) {
                controller.abort("MCP HTTP response closed before completion");
            }
        };
        request.once("aborted", abortRequest);
        response.once("close", closeResponse);
        this.#requestSignals.set(key, controller);

        try {
            await session.transport.handleRequest(request, response, body);
        } finally {
            if (this.#requestSignals.get(key) === controller) {
                this.#requestSignals.delete(key);
            }
            request.off("aborted", abortRequest);
            response.off("close", closeResponse);
        }
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
            onsessionclosed: async (sessionId) => {
                await this.#closeSession(sessionId);
            },
            onsessioninitialized: async (sessionId) => {
                this.#sessions.set(sessionId, session);
                await this.#worker.appendSessionOpened(sessionId);
            },
            sessionIdGenerator: () => randomUUID()
        });
        const session: McpEndpointSession = { server, transport };

        this.#registerHandlers(server);
        await server.connect(transport);
        return session;
    }

    async #closeSession(sessionId: string): Promise<void> {
        if (!this.#sessions.delete(sessionId)) {
            return;
        }

        await this.#worker.appendSessionClosed(sessionId);
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

        server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
            try {
                const context = {
                    principal: readPrincipal(extra.authInfo),
                    requestId: toRequestId(extra.requestId)
                };
                const requestSignal =
                    extra.sessionId === undefined
                        ? undefined
                        : this.#requestSignals.get(requestSignalKey(extra.sessionId, String(extra.requestId)))?.signal;
                const combined = combineAbortSignals(extra.signal, requestSignal);
                try {
                    const result = await this.#worker.callTool(
                        request.params.name,
                        (request.params.arguments ?? {}) as JsonValue,
                        context,
                        combined.signal
                    );
                    return toCallToolResult(result);
                } finally {
                    combined.cleanup();
                }
            } catch (error) {
                throw toMcpError(error);
            }
        });
    }
}

function readPrincipal(authInfo: { clientId: string; extra?: Record<string, unknown> } | undefined): string {
    const subject = authInfo?.extra?.subject;
    if (typeof subject === "string" && subject.length > 0) {
        return subject;
    }
    return authInfo?.clientId ?? "local";
}

function requestSignalKey(sessionId: string, requestId: string): string {
    return `${sessionId}:${requestId}`;
}

function combineAbortSignals(primary: AbortSignal, secondary: AbortSignal | undefined): {
    cleanup(): void;
    signal: AbortSignal;
} {
    if (secondary === undefined) {
        return { cleanup: () => undefined, signal: primary };
    }

    const controller = new AbortController();
    const abortFromPrimary = () => controller.abort(primary.reason);
    const abortFromSecondary = () => controller.abort(secondary.reason);
    primary.addEventListener("abort", abortFromPrimary, { once: true });
    secondary.addEventListener("abort", abortFromSecondary, { once: true });

    if (primary.aborted) {
        abortFromPrimary();
    } else if (secondary.aborted) {
        abortFromSecondary();
    }

    return {
        cleanup() {
            primary.removeEventListener("abort", abortFromPrimary);
            secondary.removeEventListener("abort", abortFromSecondary);
        },
        signal: controller.signal
    };
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

function toRequestId(value: unknown): string | undefined {
    if (typeof value === "string") {
        return value;
    }

    if (typeof value === "number") {
        return String(value);
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

function toCallToolResult(result: JsonValue) {
    return {
        content: [
            {
                type: "text" as const,
                text: JSON.stringify(result)
            }
        ],
        isError: false,
        structuredContent: result
    };
}

function toMcpError(error: unknown): McpError {
    if (error instanceof McpToolSchemaUnavailableError) {
        return new McpError(-32002, error.message, { code: error.code });
    }

    const body = toControlErrorBody(error);

    if (body?.code === "core.instanceNotReady") {
        const sanitized = sanitizeErrorBody(body);

        return new McpError(-32001, "Instance not ready.", {
            ...sanitized,
            code: "mcp.instanceNotReady"
        });
    }

    if (body !== undefined) {
        return new McpError(ErrorCode.InternalError, body.message, sanitizeErrorBody(body));
    }

    if (error instanceof Error) {
        return new McpError(ErrorCode.ConnectionClosed, error.message);
    }

    return new McpError(ErrorCode.ConnectionClosed, "Unknown MCP error.");
}

function sanitizeErrorBody(body: ControlErrorBody): Record<string, JsonValue> {
    return {
        code: body.code,
        ...(body.cause === undefined ? {} : { cause: sanitizeErrorBody(body.cause) }),
        ...(body.details === undefined ? {} : { details: sanitizeDetails(body.details) }),
        message: body.message,
        retryable: body.retryable
    };
}

function sanitizeDetails(details: JsonValue): JsonValue {
    if (Array.isArray(details)) {
        return details.map((entry) => sanitizeDetails(entry)) as JsonValue;
    }

    if (typeof details !== "object" || details === null) {
        return details;
    }

    const candidate = details as Record<string, JsonValue>;
    const filtered = Object.entries(candidate).filter(([key]) => {
        return key !== "command" && key !== "commandDisplay" && key !== "cwd" && key !== "stderrTail" && key !== "stdoutTail";
    });

    return Object.fromEntries(filtered.map(([key, value]) => [key, sanitizeDetails(value)])) as JsonValue;
}
