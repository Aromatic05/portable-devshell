import type { IncomingMessage, ServerResponse } from "node:http";

import { EXTENSION_ID } from "@modelcontextprotocol/ext-apps/server";
import {
    toNodeHandler,
    type NodeMcpRequestHandler,
} from "@modelcontextprotocol/node";
import {
    createMcpHandler,
    InMemoryServerEventBus,
    ProtocolError,
    ProtocolErrorCode,
    Server,
    type McpHttpHandler,
    type Tool,
} from "@modelcontextprotocol/server";
import {
    readToolCallErrorPayload,
    toRemoteErrorBody,
    type RemoteErrorBody,
    type JsonValue,
} from "@portable-devshell/shared";

import { McpToolSchemaUnavailableError } from "./tool/Schema.js";
import { McpEndpoint } from "./Endpoint.js";
import { McpNativeToolResult, type McpEndpointResult } from "./call/Boundary.js";
import {
    projectMcpModelOutput,
    validateMcpModelOutputBudget,
    type McpModelOutputBudget,
} from "./call/ModelOutput.js";

function requiresStreamingResponse(body: JsonValue): boolean {
    if (body === null || typeof body !== "object" || Array.isArray(body))
        return false;
    if (body.method !== "tools/call") return false;
    const params = body.params;
    if (params === null || typeof params !== "object" || Array.isArray(params))
        return true;
    // Bootstrap is inexpensive. Every other ToolCall may block on Worker,
    // network or Hook, and needs early response headers plus SSE keepalive.
    return params.name !== "environ_info";
}

export class McpEndpointBinding {
    readonly #handler: McpHttpHandler;
    readonly #nodeHandler: NodeMcpRequestHandler;
    readonly #streamHandler: McpHttpHandler;
    readonly #streamNodeHandler: NodeMcpRequestHandler;
    readonly #serverVersion: string;
    readonly #endpoint: McpEndpoint;
    readonly #modelOutput: McpModelOutputBudget;

    constructor(
        endpoint: McpEndpoint,
        serverVersion = "0.0.0",
        modelOutput: McpModelOutputBudget = {},
    ) {
        validateMcpModelOutputBudget(modelOutput);
        this.#serverVersion = serverVersion;
        this.#endpoint = endpoint;
        this.#modelOutput = modelOutput;
        // Per-request modes share a bus so subscriptions and tool calls
        // remain on the same notification stream across both handlers.
        const bus = new InMemoryServerEventBus();
        const common = {
            bus,
            keepAliveMs: 15_000,
            legacy: "reject" as const,
        };
        this.#handler = createMcpHandler(() => this.#createServer(), {
            ...common,
            responseMode: "auto",
        });
        this.#streamHandler = createMcpHandler(() => this.#createServer(), {
            ...common,
            // The Node adapter flushes headers with the first body frame.
            // Send a prompt heartbeat even if a long call emits no progress.
            keepAliveMs: 1_000,
            responseMode: "sse",
        });
        this.#nodeHandler = toNodeHandler(this.#handler);
        this.#streamNodeHandler = toNodeHandler(this.#streamHandler);
    }

    get instanceName(): string {
        return this.#endpoint.instanceName;
    }

    async handleRequest(
        request: IncomingMessage,
        response: ServerResponse,
        body: JsonValue,
    ): Promise<void> {
        await (requiresStreamingResponse(body)
            ? this.#streamNodeHandler
            : this.#nodeHandler)(request, response, body);
    }

    #createServer(): Server {
        const resources = this.#endpoint.listResources();
        const appResources = this.#endpoint.hasAppResources();
        const server = new Server(
            {
                name: "portable-devshell-mcp",
                version: this.#serverVersion,
            },
            {
                capabilities: {
                    ...(appResources
                        ? { extensions: { [EXTENSION_ID]: {} } }
                        : {}),
                    ...(resources.length > 0 ? { resources: {} } : {}),
                    tools: {},
                },
            },
        );

        if (resources.length > 0) {
            server.setRequestHandler("resources/list", async () => ({
                resources: [...resources],
            }));

            server.setRequestHandler("resources/read", async (request) => {
                const content = await this.#endpoint.readResource(
                    request.params.uri,
                );
                if (content === undefined) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InvalidParams,
                        `Unknown resource: ${request.params.uri}`,
                    );
                }
                return {
                    contents: [
                        {
                            ...(content._meta === undefined
                                ? {}
                                : { _meta: content._meta }),
                            mimeType: content.mimeType,
                            text: content.text,
                            uri: content.uri,
                        },
                    ],
                };
            });
        }

        server.setRequestHandler("tools/list", async () => {
            try {
                return {
                    tools: this.#endpoint.listTools().map(toProtocolTool),
                };
            } catch (error) {
                throw toMcpError(error);
            }
        });

        server.setRequestHandler("tools/call", async (request, ctx) => {
            try {
                const requestMeta = readRequestMeta(request.params._meta);
                const context = {
                    principal: readPrincipal(ctx.http?.authInfo),
                    ...(requestMeta === undefined ? {} : { requestMeta }),
                    requestId: toRequestId(ctx.mcpReq.id),
                };
                const result = await this.#endpoint.callTool(
                    request.params.name,
                    (request.params.arguments ?? {}) as JsonValue,
                    context,
                    ctx.mcpReq.signal,
                );
                return toCallToolResult(projectMcpModelOutput(
                    request.params.name,
                    result,
                    this.#modelOutput,
                ));
            } catch (error) {
                throw toMcpError(error);
            }
        });

        return server;
    }
}

function readPrincipal(
    authInfo: { clientId: string; extra?: Record<string, unknown> } | undefined,
): string {
    const subject = authInfo?.extra?.subject;
    if (typeof subject === "string" && subject.length > 0) {
        return subject;
    }
    return authInfo?.clientId ?? "local";
}

function readRequestMeta(meta: unknown): Record<string, unknown> | undefined {
    if (typeof meta !== "object" || meta === null || Array.isArray(meta))
        return undefined;
    return meta as Record<string, unknown>;
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

function toCallToolResult(result: McpEndpointResult) {
    if (result instanceof McpNativeToolResult) {
        return {
            ...(result._meta === undefined ? {} : { _meta: result._meta }),
            content: result.content,
            isError: result.isError,
            structuredContent: result.structuredContent,
        };
    }
    return {
        content: [],
        isError: false,
        structuredContent: result,
    };
}

function toMcpError(error: unknown): ProtocolError {
    const body = toRemoteErrorBody(error);
    const comment = readToolCallComments(readToolCallErrorPayload(error));
    if (error instanceof McpToolSchemaUnavailableError) {
        return new ProtocolError(-32002, error.message, {
            code: error.code,
            ...(comment === undefined ? {} : { comment }),
        });
    }

    if (body?.code === "core.instanceNotReady") {
        const sanitized = sanitizeErrorBody(body);

        return new ProtocolError(-32001, "Instance not ready.", {
            ...sanitized,
            code: "mcp.instanceNotReady",
            ...(comment === undefined ? {} : { comment }),
        });
    }

    if (body !== undefined) {
        return new ProtocolError(
            ProtocolErrorCode.InternalError,
            body.message,
            {
                ...sanitizeErrorBody(body),
                ...(comment === undefined ? {} : { comment }),
            },
        );
    }

    if (error instanceof Error) {
        return new ProtocolError(
            ProtocolErrorCode.InternalError,
            error.message,
            comment === undefined ? undefined : { comment },
        );
    }

    return new ProtocolError(
        ProtocolErrorCode.InternalError,
        "Unknown MCP error.",
        comment === undefined ? undefined : { comment },
    );
}

function readToolCallComments(
    payload: JsonValue | undefined,
): readonly string[] | undefined {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload))
        return undefined;
    const comment = payload.comment;
    if (!Array.isArray(comment)) return undefined;
    const entries = comment.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );
    return entries.length === 0 ? undefined : entries;
}

function toProtocolTool(
    tool: ReturnType<McpEndpoint["listTools"]>[number],
): Tool {
    if (
        typeof tool.inputSchema !== "object" ||
        tool.inputSchema === null ||
        Array.isArray(tool.inputSchema) ||
        tool.inputSchema.type !== "object"
    ) {
        throw new McpToolSchemaUnavailableError(tool.name);
    }
    return tool as unknown as Tool;
}

function sanitizeErrorBody(body: RemoteErrorBody): Record<string, JsonValue> {
    return {
        code: body.code,
        ...(body.cause === undefined
            ? {}
            : { cause: sanitizeErrorBody(body.cause) }),
        ...(body.details === undefined
            ? {}
            : { details: sanitizeDetails(body.details) }),
        message: body.message,
        retryable: body.retryable,
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
        return (
            key !== "activeCtxId" &&
            key !== "command" &&
            key !== "commandDisplay" &&
            key !== "createdByCtxId" &&
            key !== "ctxId" &&
            key !== "cwd" &&
            key !== "stderrTail" &&
            key !== "stdoutTail"
        );
    });

    return Object.fromEntries(
        filtered.map(([key, value]) => [key, sanitizeDetails(value)]),
    ) as JsonValue;
}
