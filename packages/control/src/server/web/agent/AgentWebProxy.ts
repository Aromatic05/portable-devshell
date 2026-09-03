import {
    request as httpRequest,
    type IncomingHttpHeaders,
    type IncomingMessage,
    type RequestOptions,
    type ServerResponse
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";

import type { HttpHost } from "@portable-devshell/mcp";

import type { ControlWebSessionService } from "../ControlWebSessionService.js";

export interface AgentWebRegistry {
    webEndpoint(): { upstream: string } | undefined;
}

export interface AgentWebProxyOptions {
    agent: AgentWebRegistry;
    basePath: string;
}

interface ResolvedAgentWebTarget {
    upstream: URL;
    upstreamPath: string;
}

export class AgentWebProxy {
    readonly #agent: AgentWebRegistry;
    readonly #basePath: string;

    constructor(options: AgentWebProxyOptions) {
        this.#agent = options.agent;
        this.#basePath = normalizeBasePath(options.basePath);
    }

    install(http: HttpHost, sessions: ControlWebSessionService): () => void {
        const removeHttp = http.registerRawPrefix(this.#basePath, async (request, response) => {
            if (!sessions.authorize(request)) {
                writeError(response, 401, "Unauthorized");
                return;
            }
            const target = this.#resolveHttpTarget(request);
            if (target === undefined) {
                writeError(response, 404, "Agent WebUI not found");
                return;
            }
            await proxyHttp(request, response, target, this.#basePath);
        });
        const removeUpgrade = http.registerUpgradePrefix(this.#basePath, async (request, socket, head) => {
            if (!sessions.authorize(request)) {
                rejectUpgrade(socket, 401, "Unauthorized");
                return;
            }
            const target = this.#resolveUpgradeTarget(request);
            if (target === undefined) {
                rejectUpgrade(socket, 404, "Agent WebUI not found");
                return;
            }
            await proxyUpgrade(request, socket, head, target, this.#basePath);
        });
        return () => {
            removeUpgrade();
            removeHttp();
        };
    }

    #resolveHttpTarget(request: IncomingMessage): ResolvedAgentWebTarget | undefined {
        return this.#resolveSuffix(request.url ?? "/");
    }

    #resolveUpgradeTarget(request: IncomingMessage): ResolvedAgentWebTarget | undefined {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (!pathMatchesPrefix(url.pathname, this.#basePath)) return undefined;
        const pathname = url.pathname.slice(this.#basePath.length) || "/";
        return this.#resolveSuffix(`${pathname}${url.search}`);
    }

    #resolveSuffix(value: string): ResolvedAgentWebTarget | undefined {
        const url = new URL(value, "http://localhost");
        const endpoint = this.#agent.webEndpoint();
        if (endpoint === undefined) return undefined;
        const upstream = requireLoopbackUpstream(endpoint.upstream);
        const path = url.pathname || "/";
        return {
            upstream,
            upstreamPath: `${path.startsWith("/") ? path : `/${path}`}${url.search}`
        };
    }
}

async function proxyHttp(
    request: IncomingMessage,
    response: ServerResponse,
    target: ResolvedAgentWebTarget,
    basePath: string
): Promise<void> {
    const upstreamUrl = resolveUpstreamUrl(target.upstream, target.upstreamPath);
    await new Promise<void>((resolve, reject) => {
        const proxyRequest = requestFor(upstreamUrl, {
            headers: proxyHeaders(request.headers, upstreamUrl, basePath),
            method: request.method ?? "GET"
        }, (proxyResponse) => {
            response.statusCode = proxyResponse.statusCode ?? 502;
            if (proxyResponse.statusMessage !== undefined) response.statusMessage = proxyResponse.statusMessage;
            copyResponseHeaders(proxyResponse.headers, response);
            proxyResponse.pipe(response);
            proxyResponse.once("end", resolve);
            proxyResponse.once("error", reject);
        });
        proxyRequest.once("error", reject);
        request.once("aborted", () => proxyRequest.destroy());
        request.pipe(proxyRequest);
    }).catch((error) => {
        if (!response.headersSent) {
            writeError(response, 502, error instanceof Error ? error.message : "Agent WebUI upstream failed");
            return;
        }
        response.destroy(error instanceof Error ? error : undefined);
    });
}

async function proxyUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    target: ResolvedAgentWebTarget,
    basePath: string
): Promise<void> {
    const upstreamUrl = resolveUpstreamUrl(target.upstream, target.upstreamPath);
    await new Promise<void>((resolve, reject) => {
        const proxyRequest = requestFor(upstreamUrl, {
            headers: {
                ...proxyHeaders(request.headers, upstreamUrl, basePath),
                connection: "Upgrade",
                upgrade: request.headers.upgrade ?? "websocket"
            },
            method: request.method ?? "GET"
        });
        proxyRequest.once("upgrade", (proxyResponse, upstreamSocket, upstreamHead) => {
            writeUpgradeResponse(socket, proxyResponse);
            if (upstreamHead.length > 0) socket.write(upstreamHead);
            if (head.length > 0) upstreamSocket.write(head);
            socket.pipe(upstreamSocket);
            upstreamSocket.pipe(socket);
            resolve();
        });
        proxyRequest.once("response", (proxyResponse) => {
            writeUpgradeResponse(socket, proxyResponse);
            proxyResponse.pipe(socket);
            proxyResponse.once("end", resolve);
        });
        proxyRequest.once("error", reject);
        proxyRequest.end();
    }).catch((error) => {
        if (!socket.destroyed) {
            rejectUpgrade(socket, 502, error instanceof Error ? error.message : "Agent WebUI upstream failed");
        }
    });
}

function requestFor(
    url: URL,
    options: Pick<RequestOptions, "headers" | "method">,
    onResponse?: (response: IncomingMessage) => void
) {
    return url.protocol === "https:"
        ? httpsRequest(url, options, onResponse)
        : httpRequest(url, options, onResponse);
}

function proxyHeaders(headers: IncomingHttpHeaders, upstream: URL, basePath: string): IncomingHttpHeaders {
    const next = { ...headers };
    for (const name of [
        "authorization",
        "cookie",
        "forwarded",
        "host",
        "proxy-authorization",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-port",
        "x-forwarded-proto"
    ]) {
        delete next[name];
    }
    next.host = upstream.host;
    next["x-forwarded-prefix"] = basePath;
    return next;
}

function copyResponseHeaders(headers: IncomingHttpHeaders, response: ServerResponse): void {
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined || name.toLowerCase() === "set-cookie") continue;
        response.setHeader(name, value);
    }
}

function resolveUpstreamUrl(base: URL, suffix: string): URL {
    const parsed = new URL(suffix, "http://localhost");
    const result = new URL(base.toString());
    const prefix = result.pathname === "/" ? "" : result.pathname.replace(/\/+$/u, "");
    result.pathname = `${prefix}${parsed.pathname.startsWith("/") ? parsed.pathname : `/${parsed.pathname}`}` || "/";
    result.search = parsed.search;
    result.hash = "";
    return result;
}

function requireLoopbackUpstream(value: string): URL {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Agent WebUI upstream must use http or https.");
    }
    const hostname = url.hostname.toLowerCase();
    const loopback = hostname === "localhost"
        || hostname === "::1"
        || hostname === "[::1]"
        || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
    if (!loopback) throw new Error("Agent WebUI upstream must be loopback-only.");
    return url;
}

function writeUpgradeResponse(socket: Duplex, response: IncomingMessage): void {
    const statusCode = response.statusCode ?? 502;
    const statusMessage = response.statusMessage ?? "Bad Gateway";
    socket.write(`HTTP/1.1 ${statusCode} ${statusMessage}\r\n`);
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
        const name = response.rawHeaders[index];
        const value = response.rawHeaders[index + 1];
        if (name === undefined || value === undefined || name.toLowerCase() === "set-cookie") continue;
        socket.write(`${name}: ${value}\r\n`);
    }
    socket.write("\r\n");
}

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
    const body = `${message}\n`;
    socket.end([
        `HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : statusCode === 404 ? "Not Found" : "Bad Gateway"}`,
        "Connection: close",
        "Content-Type: text/plain; charset=utf-8",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "",
        body
    ].join("\r\n"));
}

function writeError(response: ServerResponse, statusCode: number, message: string): void {
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: message }));
}

function normalizeBasePath(value: string): string {
    const trimmed = value.trim();
    if (!trimmed.startsWith("/")) throw new TypeError("Agent Web proxy base path must be absolute.");
    return trimmed === "/" ? "/" : trimmed.replace(/\/+$/u, "");
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
    return prefix === "/" || pathname === prefix || pathname.startsWith(`${prefix}/`);
}
