import type { IncomingMessage, ServerResponse } from "node:http";

import {
    EXTENSION_ID,
    RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import {
    toNodeHandler,
    type NodeMcpRequestHandler,
} from "@modelcontextprotocol/node";
import {
    createMcpHandler,
    ProtocolError,
    ProtocolErrorCode,
    Server,
    type McpHttpHandler,
    type Tool,
} from "@modelcontextprotocol/server";
import {
    toControlErrorBody,
    type ControlErrorBody,
    type JsonValue,
} from "@portable-devshell/shared";

import { McpToolSchemaUnavailableError } from "./tool/Schema.js";
import {
    workspaceAppHtml,
    workspaceAppResourceMetaForPublicBaseUrl,
    workspaceAppResourceUri,
    workspaceAppResourceUris,
} from "../workspace/app/App.js";
import { McpEndpointWorker } from "./Endpoint.js";
import { McpNativeToolResult, type McpEndpointResult } from "./Endpoint.js";
import { McpEndpointCallError } from "./dispatch/Feedback.js";

export class McpEndpointBinding {
    readonly #handler: McpHttpHandler;
    readonly #nodeHandler: NodeMcpRequestHandler;
    readonly #serverVersion: string;
    readonly #worker: McpEndpointWorker;
    readonly #workspaceResourceMeta: ReturnType<
        typeof workspaceAppResourceMetaForPublicBaseUrl
    >;

    constructor(
        worker: McpEndpointWorker,
        serverVersion = "0.0.0",
        publicBaseUrl?: string,
    ) {
        this.#serverVersion = serverVersion;
        this.#worker = worker;
        this.#workspaceResourceMeta =
            workspaceAppResourceMetaForPublicBaseUrl(publicBaseUrl);
        /**
         * @compat mcp-stateless-transport
         * @removeAt 1.0.0
         */
        this.#handler = createMcpHandler(() => this.#createServer(), {
            keepAliveMs: 15_000,
            legacy: "stateless",
            responseMode: "sse",
        });
        this.#nodeHandler = toNodeHandler(this.#handler);
    }

    get instanceName(): string {
        return this.#worker.instanceName;
    }

    async restoreTmuxWaits(): Promise<void> {
        await this.#worker.restoreTmuxWaits();
    }

    async handleRequest(
        request: IncomingMessage,
        response: ServerResponse,
        body: JsonValue,
    ): Promise<void> {
        await this.#nodeHandler(request, response, body);
    }

    #createServer(): Server {
        const workspaceApp = this.#worker.hasWorkspaceApp();
        const server = new Server(
            {
                name: "portable-devshell-mcp",
                version: this.#serverVersion,
            },
            {
                capabilities: {
                    ...(workspaceApp
                        ? { extensions: { [EXTENSION_ID]: {} } }
                        : {}),
                    ...(workspaceApp ? { resources: {} } : {}),
                    tools: {},
                },
            },
        );

        if (workspaceApp) {
            server.setRequestHandler("resources/list", async () => ({
                resources: [
                    {
                        mimeType: RESOURCE_MIME_TYPE,
                        name: "portable-devshell Workspace",
                        uri: workspaceAppResourceUri,
                    },
                ],
            }));

            server.setRequestHandler("resources/read", async (request) => {
                if (
                    !workspaceAppResourceUris.includes(
                        request.params
                            .uri as (typeof workspaceAppResourceUris)[number],
                    )
                ) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InvalidParams,
                        `Unknown resource: ${request.params.uri}`,
                    );
                }
                return {
                    contents: [
                        {
                            _meta: this.#workspaceResourceMeta,
                            mimeType: RESOURCE_MIME_TYPE,
                            text: workspaceAppHtml,
                            uri: request.params.uri,
                        },
                    ],
                };
            });
        }

        server.setRequestHandler("tools/list", async () => {
            try {
                return {
                    tools: this.#worker.listTools().map(toProtocolTool),
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
                const result = await this.#worker.callTool(
                    request.params.name,
                    (request.params.arguments ?? {}) as JsonValue,
                    context,
                    ctx.mcpReq.signal,
                );
                return toCallToolResult(result);
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
    const failure =
        error instanceof McpEndpointCallError ? error : undefined;
    const sourceError = failure?.original ?? error;
    const body = toControlErrorBody(sourceError);
    const comment =
        failure === undefined || failure.feedback.length === 0
            ? undefined
            : [...failure.feedback];
    if (sourceError instanceof McpToolSchemaUnavailableError) {
        return new ProtocolError(-32002, sourceError.message, {
            code: sourceError.code,
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

    if (sourceError instanceof Error) {
        return new ProtocolError(
            ProtocolErrorCode.InternalError,
            sourceError.message,
            comment === undefined ? undefined : { comment },
        );
    }

    return new ProtocolError(
        ProtocolErrorCode.InternalError,
        "Unknown MCP error.",
        comment === undefined ? undefined : { comment },
    );
}

function toProtocolTool(
    tool: ReturnType<McpEndpointWorker["listTools"]>[number],
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

function sanitizeErrorBody(body: ControlErrorBody): Record<string, JsonValue> {
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
