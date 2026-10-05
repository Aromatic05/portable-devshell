import type { IncomingMessage, ServerResponse } from "node:http";

import type { JsonValue } from "@portable-devshell/shared";

import type { ContextTransport } from "@portable-devshell/shared";
import {
    isMcpAppActionGateway,
    isMcpAppGateway,
    type McpAppActionGateway,
    type McpAppGateway,
    type McpAppPort,
} from "../instance/Gateway.js";
import { readMcpAppSnapshot } from "./Projection.js";
import { mcpAppEventBelongsTo } from "./contributor/Activity.js";
import { McpAppLeaseStore } from "./app/Lease.js";
import { McpAppPresenceStore } from "./app/Presence.js";
import { McpAppActionStore } from "./ActionStore.js";

const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_POLL_MS = 250;

export interface McpAppLiveRouteHost {
    registerRawRoute(
        method: "delete" | "get" | "head" | "options" | "post",
        path: string,
        handler: (
            request: IncomingMessage,
            response: ServerResponse,
        ) => void | Promise<void>,
    ): () => void;
}

export interface McpAppLiveRouteOptions {
    context: Pick<ContextTransport, "reentry" | "validateForInstance">;
    gateway?: McpAppPort;
    heartbeatMs?: number;
    host: McpAppLiveRouteHost;
    instanceName: string;
    leases: McpAppLeaseStore;
    actions: McpAppActionStore;
    pollMs?: number;
    presence: McpAppPresenceStore;
    publicBaseUrl?: string;
}

export function mcpAppLiveRoutePath(instanceName: string): string {
    return `/api/live/${encodeURIComponent(instanceName)}/mcpapp`;
}

export function mcpAppLiveBaseUrl(
    publicBaseUrl: string | undefined,
    instanceName: string,
): string | undefined {
    if (publicBaseUrl === undefined) return undefined;
    const url = new URL(publicBaseUrl);
    if (url.hostname === "0.0.0.0" || url.hostname === "[::]") return undefined;
    url.pathname = joinUrlPaths(
        url.pathname,
        mcpAppLiveRoutePath(instanceName),
    );
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
}

export function installMcpAppLiveRoute(
    options: McpAppLiveRouteOptions,
): () => void {
    const gateway = isMcpAppActionGateway(options.gateway)
        ? options.gateway
        : undefined;
    const mcpAppGateway = isMcpAppGateway(options.gateway)
        ? options.gateway
        : undefined;
    if (gateway === undefined || mcpAppGateway === undefined)
        return () => undefined;

    const cleanups = liveRouteBases(
        options.instanceName,
        options.publicBaseUrl,
    ).flatMap((base) =>
        registerLiveRouteBase(options, gateway, mcpAppGateway, base),
    );
    return () => {
        for (const cleanup of cleanups) cleanup();
    };
}

function registerLiveRouteBase(
    options: McpAppLiveRouteOptions,
    gateway: McpAppActionGateway,
    mcpAppGateway: McpAppGateway,
    base: string,
): Array<() => void> {
    return [
        options.host.registerRawRoute(
            "options",
            `${base}/snapshot`,
            (_request, response) => {
                writeCors(response);
                response.statusCode = 204;
                response.end();
            },
        ),
        options.host.registerRawRoute(
            "options",
            `${base}/watch`,
            (_request, response) => {
                writeCors(response);
                response.statusCode = 204;
                response.end();
            },
        ),
        options.host.registerRawRoute(
            "get",
            `${base}/snapshot`,
            async (request, response) => {
                writeCors(response);
                try {
                    const authorized = await authorize(request, options);
                    const { ctxId } = authorized;
                    options.presence.touch(options.instanceName, ctxId);
                    writeJson(
                        response,
                        200,
                        await readMcpAppSnapshot(
                            gateway,
                            options.instanceName,
                            ctxId,
                            {
                                instances: authorized.instances,
                                reentry: authorized.reentry,
                                directives: await options.actions.pendingDirectives(ctxId, options.instanceName),
                            },
                        ),
                    );
                } catch (error) {
                    writeLiveError(response, error);
                }
            },
        ),
        options.host.registerRawRoute(
            "get",
            `${base}/watch`,
            async (request, response) => {
                writeCors(response);
                const disconnect = new AbortController();
                const abort = () => {
                    if (!response.writableEnded)
                        disconnect.abort("MCP App connection closed");
                };
                request.once("aborted", abort);
                response.once("close", abort);
                let ctxId: string | undefined;
                try {
                    const authorized = await authorize(request, options);
                    ctxId = authorized.ctxId;
                    let cursor = readCursor(request);
                    const startedAt = Date.now();
                    const heartbeatMs =
                        authorized.instances.length > 1
                            ? Math.min(
                                  options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
                                  1_000,
                              )
                            : (options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
                    options.presence.beginWatch(options.instanceName, ctxId);
                    while (!disconnect.signal.aborted) {
                        const batch =
                            await mcpAppGateway.readMcpAppEvents(
                                options.instanceName,
                                cursor + 1,
                            );
                        const changed =
                            batch.gap ||
                            batch.lastSeq < cursor ||
                            batch.events.some((event) =>
                                mcpAppEventBelongsTo(event, ctxId!),
                            );
                        cursor = batch.lastSeq;
                        if (changed || Date.now() - startedAt >= heartbeatMs) {
                            writeJson(response, 200, {
                                changed,
                                cursor,
                                snapshot: await readMcpAppSnapshot(
                                    gateway,
                                    options.instanceName,
                                    ctxId,
                                    {
                                        instances: authorized.instances,
                                        reentry:
                                            (await options.context.reentry.readAutomaticReentry(
                                                ctxId,
                                                options.instanceName,
                                            )) as unknown as JsonValue,
                                        directives: await options.actions.pendingDirectives(ctxId, options.instanceName),
                                    },
                                ),
                            });
                            return;
                        }
                        await abortableDelay(
                            options.pollMs ?? DEFAULT_POLL_MS,
                            disconnect.signal,
                        );
                    }
                } catch (error) {
                    if (!disconnect.signal.aborted)
                        writeLiveError(response, error);
                } finally {
                    if (ctxId !== undefined)
                        options.presence.endWatch(options.instanceName, ctxId);
                    request.off("aborted", abort);
                    response.off("close", abort);
                }
            },
        ),
    ];
}

function liveRouteBases(
    instanceName: string,
    publicBaseUrl: string | undefined,
): string[] {
    const base = mcpAppLiveRoutePath(instanceName);
    if (publicBaseUrl === undefined) return [base];
    const prefix = new URL(publicBaseUrl).pathname;
    if (prefix === "/") return [base];
    const prefixed = joinUrlPaths(prefix, base);
    return prefixed === base ? [base] : [base, prefixed];
}

async function authorize(
    request: IncomingMessage,
    options: McpAppLiveRouteOptions,
): Promise<{ ctxId: string; instances: string[]; reentry: JsonValue }> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const ctxId = url.searchParams.get("ctxId") ?? "";
    if (ctxId.length === 0) throw new LiveRouteError(400, "ctxId is required");
    const token = bearerToken(request.headers.authorization);
    if (
        token === undefined ||
        !(await options.leases.verify(options.instanceName, ctxId, token))
    ) {
        throw new LiveRouteError(
            401,
            "MCP App authorization is invalid for the current Context.",
        );
    }
    try {
        const record = await options.context.validateForInstance(
            ctxId,
            options.instanceName,
        );
        const reentry = await options.context.reentry.readAutomaticReentry(
            ctxId,
            options.instanceName,
        );
        return {
            ctxId,
            instances: record.environments.map(
                (environment) => environment.instance,
            ),
            reentry: reentry as unknown as JsonValue,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/expired|disabled/iu.test(message))
            throw new LiveRouteError(401, message);
        throw new LiveRouteError(
            401,
            "McpApp Context is unavailable for this capability.",
        );
    }
}

function readCursor(request: IncomingMessage): number {
    const url = new URL(request.url ?? "/", "http://localhost");
    const raw = url.searchParams.get("cursor") ?? "0";
    if (!/^\d+$/u.test(raw))
        throw new LiveRouteError(400, "cursor must be a non-negative integer");
    const cursor = Number(raw);
    if (!Number.isSafeInteger(cursor))
        throw new LiveRouteError(400, "cursor must be a non-negative integer");
    return cursor;
}

function bearerToken(value: string | undefined): string | undefined {
    const match = /^Bearer\s+(.+)$/iu.exec(value ?? "");
    return match?.[1];
}

function writeCors(response: ServerResponse): void {
    response.setHeader("Access-Control-Allow-Headers", "Authorization");
    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Vary", "Origin");
}

function writeJson(
    response: ServerResponse,
    statusCode: number,
    value: JsonValue,
): void {
    if (response.headersSent || response.writableEnded) return;
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(value));
}

function writeLiveError(response: ServerResponse, error: unknown): void {
    if (response.headersSent || response.writableEnded) return;
    if (error instanceof LiveRouteError) {
        writeJson(response, error.statusCode, { error: error.message });
        return;
    }
    const message =
        error instanceof Error
            ? error.message
            : "MCP App request failed";
    const statusCode = /Context|expired|disabled/iu.test(message) ? 401 : 500;
    writeJson(response, statusCode, {
        error: statusCode === 500 ? "MCP App request failed" : message,
    });
}

function abortableDelay(
    milliseconds: number,
    signal: AbortSignal,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        const timer = setTimeout(done, milliseconds);
        function done() {
            signal.removeEventListener("abort", aborted);
            resolve();
        }
        function aborted() {
            clearTimeout(timer);
            signal.removeEventListener("abort", aborted);
            reject(signal.reason);
        }
        signal.addEventListener("abort", aborted, { once: true });
    });
}

function joinUrlPaths(basePathname: string, nextPathname: string): string {
    const base = basePathname === "/" ? "" : basePathname.replace(/\/+$/u, "");
    const next = nextPathname.startsWith("/")
        ? nextPathname
        : `/${nextPathname}`;
    return `${base}${next}`;
}

class LiveRouteError extends Error {
    constructor(
        readonly statusCode: number,
        message: string,
    ) {
        super(message);
    }
}
