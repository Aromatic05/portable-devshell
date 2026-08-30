import type { IncomingMessage, ServerResponse } from "node:http";

import type { JsonValue } from "@portable-devshell/shared";

import { McpContextRegistry } from "../context/McpContextRegistry.js";
import type { HttpHost } from "../host/HttpHost.js";
import {
    isMcpInteractionGateway,
    isMcpWorkspaceGateway,
    type McpInteractionGateway,
    type McpInstanceGateway,
    type McpWorkspaceGateway,
} from "../instance/McpInstanceGateway.js";
import { readWorkspaceSnapshot, workspaceEventBelongsTo } from "./McpWorkspaceSnapshot.js";
import { WorkspaceAppLeaseStore } from "./WorkspaceAppLeaseStore.js";
import { WorkspaceAppPresenceStore } from "./WorkspaceAppPresenceStore.js";

const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_POLL_MS = 250;

export interface McpWorkspaceLiveRouteOptions {
    contextRegistry: McpContextRegistry;
    gateway?: McpInstanceGateway;
    heartbeatMs?: number;
    host: HttpHost;
    instanceName: string;
    leases: WorkspaceAppLeaseStore;
    pollMs?: number;
    presence: WorkspaceAppPresenceStore;
    publicBaseUrl?: string;
    restoreTmuxWaits?: () => Promise<void>;
}

export function workspaceLiveRoutePath(instanceName: string): string {
    return `/api/live/${encodeURIComponent(instanceName)}/workspace`;
}

export function workspaceLiveBaseUrl(
    publicBaseUrl: string | undefined,
    instanceName: string,
): string | undefined {
    if (publicBaseUrl === undefined) return undefined;
    const url = new URL(publicBaseUrl);
    if (url.hostname === "0.0.0.0" || url.hostname === "[::]") return undefined;
    url.pathname = joinUrlPaths(url.pathname, workspaceLiveRoutePath(instanceName));
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
}

export function installMcpWorkspaceLiveRoute(
    options: McpWorkspaceLiveRouteOptions,
): () => void {
    const gateway = isMcpInteractionGateway(options.gateway) ? options.gateway : undefined;
    const workspaceGateway = isMcpWorkspaceGateway(options.gateway) ? options.gateway : undefined;
    if (gateway === undefined || workspaceGateway === undefined) return () => undefined;

    const cleanups = liveRouteBases(options.instanceName, options.publicBaseUrl).flatMap((base) =>
        registerLiveRouteBase(options, gateway, workspaceGateway, base)
    );
    return () => {
        for (const cleanup of cleanups) cleanup();
    };
}

function registerLiveRouteBase(
    options: McpWorkspaceLiveRouteOptions,
    gateway: McpInteractionGateway,
    workspaceGateway: McpWorkspaceGateway,
    base: string,
): Array<() => void> {
    return [
        options.host.registerRawRoute("options", `${base}/snapshot`, (_request, response) => {
            writeCors(response);
            response.statusCode = 204;
            response.end();
        }),
        options.host.registerRawRoute("options", `${base}/watch`, (_request, response) => {
            writeCors(response);
            response.statusCode = 204;
            response.end();
        }),
        options.host.registerRawRoute("get", `${base}/snapshot`, async (request, response) => {
            writeCors(response);
            try {
                const { ctxId } = await authorize(request, options);
                await options.restoreTmuxWaits?.();
                options.presence.touch(options.instanceName, ctxId);
                writeJson(response, 200, await readWorkspaceSnapshot(gateway, options.instanceName, ctxId));
            } catch (error) {
                writeLiveError(response, error);
            }
        }),
        options.host.registerRawRoute("get", `${base}/watch`, async (request, response) => {
            writeCors(response);
            const disconnect = new AbortController();
            const abort = () => {
                if (!response.writableEnded) disconnect.abort("Live Workspace connection closed");
            };
            request.once("aborted", abort);
            response.once("close", abort);
            let ctxId: string | undefined;
            try {
                const authorized = await authorize(request, options);
                ctxId = authorized.ctxId;
                await options.restoreTmuxWaits?.();
                let cursor = readCursor(request);
                const startedAt = Date.now();
                options.presence.beginWatch(options.instanceName, ctxId);
                while (!disconnect.signal.aborted) {
                    const batch = await workspaceGateway.readWorkspaceEvents(options.instanceName, cursor + 1);
                    const changed = batch.gap || batch.lastSeq < cursor ||
                        batch.events.some((event) => workspaceEventBelongsTo(event, ctxId!));
                    cursor = batch.lastSeq;
                    if (changed || Date.now() - startedAt >= (options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS)) {
                        writeJson(response, 200, {
                            changed,
                            cursor,
                            snapshot: await readWorkspaceSnapshot(gateway, options.instanceName, ctxId),
                        });
                        return;
                    }
                    await abortableDelay(options.pollMs ?? DEFAULT_POLL_MS, disconnect.signal);
                }
            } catch (error) {
                if (!disconnect.signal.aborted) writeLiveError(response, error);
            } finally {
                if (ctxId !== undefined) options.presence.endWatch(options.instanceName, ctxId);
                request.off("aborted", abort);
                response.off("close", abort);
            }
        }),
    ];
}

function liveRouteBases(instanceName: string, publicBaseUrl: string | undefined): string[] {
    const base = workspaceLiveRoutePath(instanceName);
    if (publicBaseUrl === undefined) return [base];
    const prefix = new URL(publicBaseUrl).pathname;
    if (prefix === "/") return [base];
    const prefixed = joinUrlPaths(prefix, base);
    return prefixed === base ? [base] : [base, prefixed];
}

async function authorize(
    request: IncomingMessage,
    options: McpWorkspaceLiveRouteOptions,
): Promise<{ ctxId: string }> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const ctxId = url.searchParams.get("ctxId") ?? "";
    if (ctxId.length === 0) throw new LiveRouteError(400, "ctxId is required");
    const token = bearerToken(request.headers.authorization);
    if (token === undefined || !await options.leases.verify(options.instanceName, ctxId, token)) {
        throw new LiveRouteError(401, "Workspace App authorization is invalid for the current Context.");
    }
    try {
        await options.contextRegistry.validateForInstance(ctxId, options.instanceName);
    } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/expired|disabled/iu.test(message)) throw new LiveRouteError(401, message);
        throw new LiveRouteError(401, "Workspace Context is unavailable for this capability.");
    }
    return { ctxId };
}

function readCursor(request: IncomingMessage): number {
    const url = new URL(request.url ?? "/", "http://localhost");
    const raw = url.searchParams.get("cursor") ?? "0";
    if (!/^\d+$/u.test(raw)) throw new LiveRouteError(400, "cursor must be a non-negative integer");
    const cursor = Number(raw);
    if (!Number.isSafeInteger(cursor)) throw new LiveRouteError(400, "cursor must be a non-negative integer");
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

function writeJson(response: ServerResponse, statusCode: number, value: JsonValue): void {
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
    const message = error instanceof Error ? error.message : "Live Workspace request failed";
    const statusCode = /Context|expired|disabled/iu.test(message) ? 401 : 500;
    writeJson(response, statusCode, { error: statusCode === 500 ? "Live Workspace request failed" : message });
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
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
    const next = nextPathname.startsWith("/") ? nextPathname : `/${nextPathname}`;
    return `${base}${next}`;
}

class LiveRouteError extends Error {
    constructor(readonly statusCode: number, message: string) {
        super(message);
    }
}
