import type { IncomingMessage, ServerResponse } from "node:http";

import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
    CallToolRequestSchema,
    ErrorCode,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    McpError,
    ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { mergeComments, resolveErrorHints, toControlErrorBody, type ControlErrorBody, type JsonValue } from "@portable-devshell/shared";

import { McpToolSchemaUnavailableError } from "../tool/McpToolSchemaAdapter.js";
import { workspaceAppHtml, workspaceAppResourceMetaForPublicBaseUrl, workspaceAppResourceUri, workspaceAppResourceUris } from "../workspace/McpWorkspaceApp.js";
import { McpEndpointWorker } from "./McpEndpointWorker.js";
import { McpNativeToolResult, type McpEndpointResult } from "./McpEndpointResult.js";

export class McpEndpointBinding {
    readonly #serverVersion: string;
    readonly #worker: McpEndpointWorker;
    readonly #workspaceResourceMeta: ReturnType<typeof workspaceAppResourceMetaForPublicBaseUrl>;

    constructor(worker: McpEndpointWorker, serverVersion = "0.0.0", publicBaseUrl?: string) {
        this.#serverVersion = serverVersion;
        this.#worker = worker;
        this.#workspaceResourceMeta = workspaceAppResourceMetaForPublicBaseUrl(publicBaseUrl);
    }

    get instanceName(): string {
        return this.#worker.instanceName;
    }

    async restoreTmuxWaits(): Promise<void> {
        await this.#worker.restoreTmuxWaits();
    }

    async handleRequest(request: IncomingMessage, response: ServerResponse, body: JsonValue): Promise<void> {
        const disconnect = new AbortController();
        const abortOnDisconnect = () => {
            if (!response.writableEnded) {
                disconnect.abort("MCP HTTP connection closed before completion");
            }
        };
        request.once("aborted", abortOnDisconnect);
        response.once("close", abortOnDisconnect);

        const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
        const server = this.#createServer(disconnect.signal);
        try {
            await server.connect(transport);
            await transport.handleRequest(request, response, body);
        } finally {
            request.off("aborted", abortOnDisconnect);
            response.off("close", abortOnDisconnect);
            await Promise.allSettled([server.close(), transport.close()]);
        }
    }

    #createServer(disconnectSignal: AbortSignal): Server {
        const workspaceApp = this.#worker.hasWorkspaceApp();
        const server = new Server(
            {
                name: "portable-devshell-mcp",
                version: this.#serverVersion
            },
            {
                capabilities: {
                    ...(workspaceApp ? { extensions: { [EXTENSION_ID]: {} } } : {}),
                    ...(workspaceApp ? { resources: {} } : {}),
                    tools: {}
                }
            }
        );

        if (workspaceApp) {
            server.setRequestHandler(ListResourcesRequestSchema, async () => ({
                resources: [{
                    mimeType: RESOURCE_MIME_TYPE,
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
                        _meta: this.#workspaceResourceMeta,
                        mimeType: RESOURCE_MIME_TYPE,
                        text: workspaceAppHtml,
                        uri: request.params.uri
                    }]
                };
            });
        }

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
                const requestMeta = readRequestMeta(request.params._meta);
                const context = {
                    principal: readPrincipal(extra.authInfo),
                    ...(requestMeta === undefined ? {} : { requestMeta }),
                    requestId: toRequestId(extra.requestId)
                };
                const combined = combineAbortSignals(extra.signal, disconnectSignal);
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

        return server;
    }
}

function readPrincipal(authInfo: { clientId: string; extra?: Record<string, unknown> } | undefined): string {
    const subject = authInfo?.extra?.subject;
    if (typeof subject === "string" && subject.length > 0) {
        return subject;
    }
    return authInfo?.clientId ?? "local";
}

function readRequestMeta(meta: unknown): Record<string, unknown> | undefined {
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
    return meta as Record<string, unknown>;
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
        return key !== "activeCtxId" && key !== "command" && key !== "commandDisplay" && key !== "createdByCtxId" &&
            key !== "ctxId" && key !== "cwd" && key !== "stderrTail" && key !== "stdoutTail";
    });

    return Object.fromEntries(filtered.map(([key, value]) => [key, sanitizeDetails(value)])) as JsonValue;
}
