import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
    CallToolRequestSchema,
    ErrorCode,
    isInitializeRequest,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    McpError,
    ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { mergeComments, resolveErrorHints, toControlErrorBody, type ControlErrorBody, type JsonValue } from "@portable-devshell/shared";

import { McpToolSchemaUnavailableError } from "../tool/McpToolSchemaAdapter.js";
import { workspaceAppHtml, workspaceAppResourceMeta, workspaceAppResourceUri, workspaceAppResourceUris } from "../workspace/McpWorkspaceApp.js";
import { McpEndpointWorker } from "./McpEndpointWorker.js";
import { McpNativeToolResult, type McpEndpointResult } from "./McpEndpointResult.js";

interface McpEndpointSession {
    server: Server;
    transport: StreamableHTTPServerTransport;
}

export class McpEndpointBinding {
    readonly #requestSignals = new Map<string, AbortController>();
    readonly #serverVersion: string;
    readonly #sessions = new Map<string, McpEndpointSession>();
    readonly #worker: McpEndpointWorker;

    constructor(worker: McpEndpointWorker, serverVersion = "0.0.0") {
        this.#serverVersion = serverVersion;
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
                version: this.#serverVersion
            },
            {
                capabilities: {
                    resources: {},
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
        server.setRequestHandler(ListResourcesRequestSchema, async () => ({
            resources: [{
                mimeType: "text/html;profile=mcp-app",
                name: "portable-devshell Workspace",
                uri: workspaceAppResourceUri
            }]
        }));

        server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            if (!workspaceAppResourceUris.includes(request.params.uri as typeof workspaceAppResourceUris[number])) {
                throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${request.params.uri}`);
            }
            return {
                contents: [{
                    _meta: workspaceAppResourceMeta,
                    mimeType: "text/html;profile=mcp-app",
                    text: workspaceAppHtml,
                    uri: request.params.uri
                }]
            };
        });

        server.setRequestHandler(ListToolsRequestSchema, async () => {
            try {
                return {
                    tools: this.#worker.listTools()
                };
            } catch (error) {
                throw toMcpError(error, undefined);
            }
        });

        server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
            try {
                const context = {
                    ...readOpenAiSession(request.params._meta),
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
                throw toMcpError(error, request.params.name);
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

function readOpenAiSession(meta: unknown): { openAiSessionId?: string } {
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return {};
    const session = (meta as Record<string, unknown>)["openai/session"];
    return typeof session === "string" && session.length > 0 ? { openAiSessionId: session } : {};
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

function toCallToolResult(result: McpEndpointResult) {
    if (result instanceof McpNativeToolResult) {
        return {
            ...(result._meta === undefined ? {} : { _meta: result._meta }),
            content: result.content,
            isError: result.isError,
            structuredContent: result.structuredContent
        };
    }
    return {
        content: [],
        isError: false,
        structuredContent: result
    };
}

function toMcpError(error: unknown, toolName: string | undefined): McpError {
    const body = toControlErrorBody(error);
    const comment = mergeErrorComment(error, body, toolName);
    if (error instanceof McpToolSchemaUnavailableError) {
        return new McpError(-32002, error.message, { code: error.code, ...(comment === undefined ? {} : { comment }) });
    }

    if (body?.code === "core.instanceNotReady") {
        const sanitized = sanitizeErrorBody(body);

        return new McpError(-32001, "Instance not ready.", {
            ...sanitized,
            code: "mcp.instanceNotReady",
            ...(comment === undefined ? {} : { comment })
        });
    }

    if (body !== undefined) {
        return new McpError(ErrorCode.InternalError, body.message, {
            ...sanitizeErrorBody(body),
            ...(comment === undefined ? {} : { comment })
        });
    }

    if (error instanceof Error) {
        return new McpError(
            ErrorCode.ConnectionClosed,
            error.message,
            comment === undefined ? undefined : { comment }
        );
    }

    return new McpError(
        ErrorCode.ConnectionClosed,
        "Unknown MCP error.",
        comment === undefined ? undefined : { comment }
    );
}

function mergeErrorComment(
    error: unknown,
    body: ControlErrorBody | undefined,
    toolName: string | undefined
): string[] | undefined {
    const userComments = readComment(error) ?? [];
    const hints = body === undefined ? [] : resolveErrorHints(toolName ?? "", body);
    const merged = mergeComments(userComments, hints);
    return merged.length > 0 ? merged : undefined;
}

function readComment(error: unknown): string[] | undefined {
    if (typeof error !== "object" || error === null || !("comment" in error)) return undefined;
    const { comment } = error;
    return Array.isArray(comment) && comment.every((entry) => typeof entry === "string") ? comment : undefined;
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
