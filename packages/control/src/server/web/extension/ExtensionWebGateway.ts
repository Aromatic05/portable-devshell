import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import {
    request as httpRequest,
    type IncomingHttpHeaders,
    type IncomingMessage,
    type RequestOptions,
    type ServerResponse
} from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { Duplex } from "node:stream";

import type { HttpHost } from "@portable-devshell/mcp";

import type { ExtensionHost } from "../../../control/extension/host/ExtensionHost.js";
import type { ExtensionPathLayout } from "../../../control/extension/state/ExtensionPathLayout.js";
import type { ControlWebSessionService } from "../ControlWebSessionService.js";

export interface ExtensionWebGatewayOptions {
    basePath: string;
    extensions: ExtensionHost;
    loginPath: string;
    paths: ExtensionPathLayout;
}

interface ExtensionWebRequestTarget {
    extensionId: string;
    mountPath: string;
    suffix: string;
}

interface ResolvedProxyTarget {
    upstream: URL;
    upstreamPath: string;
}

export class ExtensionWebGateway {
    readonly #basePath: string;
    readonly #extensions: ExtensionHost;
    readonly #loginPath: string;
    readonly #paths: ExtensionPathLayout;

    constructor(options: ExtensionWebGatewayOptions) {
        this.#basePath = normalizeBasePath(options.basePath);
        this.#extensions = options.extensions;
        this.#loginPath = normalizeLoginPath(options.loginPath);
        this.#paths = options.paths;
    }

    install(http: HttpHost, sessions: ControlWebSessionService): () => void {
        const removeHttp = http.registerRawPrefix(this.#basePath, async (request, response) => {
            const target = parseMountedRequest(request.url ?? "/", this.#basePath);
            if (target === undefined) {
                writeError(response, 404, "Extension WebUI not found");
                return;
            }
            if (!sessions.authorize(request)) {
                if (isBrowserEntryRequest(request, target.suffix)) {
                    redirectToLogin(response, this.#loginPath, this.#returnPath(request.url ?? "/"));
                    return;
                }
                writeError(response, 401, "Unauthorized");
                return;
            }

            let lease;
            try {
                lease = this.#extensions.acquire(target.extensionId);
            } catch {
                writeError(response, 404, "Extension WebUI not found");
                return;
            }
            try {
                const contribution = lease.activation.web;
                if (contribution === undefined) {
                    writeError(response, 404, "Extension WebUI not found");
                    return;
                }
                if (contribution.kind === "static") {
                    const directory = resolve(
                        this.#paths.generationDirectory(target.extensionId, lease.generation),
                        contribution.directory
                    );
                    await serveStatic(request, response, directory, target.suffix);
                    return;
                }
                const upstream = await contribution.resolveUpstream();
                if (upstream === undefined) {
                    writeError(response, 404, "Extension WebUI not found");
                    return;
                }
                await proxyHttp(request, response, {
                    upstream: requireLoopbackUpstream(upstream),
                    upstreamPath: target.suffix
                }, target.mountPath);
            } finally {
                lease.release();
            }
        });

        const removeUpgrade = http.registerUpgradePrefix(this.#basePath, async (request, socket, head) => {
            if (!sessions.authorize(request)) {
                rejectUpgrade(socket, 401, "Unauthorized");
                return;
            }
            const target = parseFullRequest(request.url ?? "/", this.#basePath);
            if (target === undefined) {
                rejectUpgrade(socket, 404, "Extension WebUI not found");
                return;
            }
            let lease;
            try {
                lease = this.#extensions.acquire(target.extensionId);
            } catch {
                rejectUpgrade(socket, 404, "Extension WebUI not found");
                return;
            }
            try {
                const contribution = lease.activation.web;
                if (contribution?.kind !== "proxy") {
                    rejectUpgrade(socket, 404, "Extension WebSocket not found");
                    return;
                }
                const upstream = await contribution.resolveUpstream();
                if (upstream === undefined) {
                    rejectUpgrade(socket, 404, "Extension WebSocket not found");
                    return;
                }
                await proxyUpgrade(request, socket, head, {
                    upstream: requireLoopbackUpstream(upstream),
                    upstreamPath: target.suffix
                }, target.mountPath);
            } finally {
                lease.release();
            }
        });

        return () => {
            removeUpgrade();
            removeHttp();
        };
    }

    #returnPath(value: string): string {
        const url = new URL(value, "http://localhost");
        const suffix = url.pathname === "/" ? "/" : `/${url.pathname.replace(/^\/+/, "")}`;
        return `${this.#basePath}${suffix}${url.search}`;
    }
}

function parseMountedRequest(value: string, basePath: string): ExtensionWebRequestTarget | undefined {
    const parsed = new URL(value, "http://localhost");
    return parseExtensionSuffix(`${parsed.pathname}${parsed.search}`, basePath);
}

function parseFullRequest(value: string, basePath: string): ExtensionWebRequestTarget | undefined {
    const parsed = new URL(value, "http://localhost");
    if (!pathMatchesPrefix(parsed.pathname, basePath)) return undefined;
    const suffix = parsed.pathname.slice(basePath.length) || "/";
    return parseExtensionSuffix(`${suffix}${parsed.search}`, basePath);
}

function parseExtensionSuffix(value: string, basePath: string): ExtensionWebRequestTarget | undefined {
    const parsed = new URL(value, "http://localhost");
    const match = /^\/([^/]+)(\/.*)?$/u.exec(parsed.pathname);
    if (match === null) return undefined;
    let extensionId: string;
    try {
        extensionId = decodeURIComponent(match[1]!);
    } catch {
        return undefined;
    }
    if (!/^[a-z][a-z0-9-]*$/u.test(extensionId)) return undefined;
    const pathname = match[2] ?? "/";
    return {
        extensionId,
        mountPath: `${basePath}/${extensionId}`,
        suffix: `${pathname}${parsed.search}`
    };
}

async function serveStatic(
    request: IncomingMessage,
    response: ServerResponse,
    directory: string,
    suffix: string
): Promise<void> {
    const method = (request.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
        response.statusCode = 405;
        response.setHeader("Allow", "GET, HEAD");
        response.end();
        return;
    }
    const parsed = new URL(suffix, "http://localhost");
    let decoded: string;
    try {
        decoded = decodeURIComponent(parsed.pathname);
    } catch {
        writeError(response, 400, "Invalid Extension WebUI path");
        return;
    }
    if (decoded.includes("\0")) {
        writeError(response, 400, "Invalid Extension WebUI path");
        return;
    }

    const root = await realpath(directory);
    const relativePath = decoded.replace(/^\/+/, "");
    let candidate = resolve(root, relativePath.length === 0 ? "index.html" : relativePath);
    let metadata = await lstat(candidate).catch((error: unknown) => isMissing(error) ? undefined : Promise.reject(error));
    if (metadata?.isDirectory()) {
        candidate = resolve(candidate, "index.html");
        metadata = await lstat(candidate).catch((error: unknown) => isMissing(error) ? undefined : Promise.reject(error));
    }
    if (metadata === undefined || !metadata.isFile()) {
        writeError(response, 404, "Extension WebUI asset not found");
        return;
    }
    const actual = await realpath(candidate);
    const containment = relative(root, actual);
    if (containment.startsWith("..") || isAbsolute(containment)) {
        writeError(response, 404, "Extension WebUI asset not found");
        return;
    }

    response.statusCode = 200;
    response.setHeader("Content-Length", metadata.size);
    response.setHeader("Content-Type", contentType(actual));
    applyStaticSecurityHeaders(response, actual);
    if (method === "HEAD") {
        response.end();
        return;
    }
    await new Promise<void>((resolveStream, rejectStream) => {
        const stream = createReadStream(actual);
        const finish = () => resolveStream();
        stream.once("error", rejectStream);
        response.once("close", finish);
        response.once("finish", finish);
        stream.pipe(response);
    });
}

async function proxyHttp(
    request: IncomingMessage,
    response: ServerResponse,
    target: ResolvedProxyTarget,
    mountPath: string
): Promise<void> {
    const upstreamUrl = resolveUpstreamUrl(target.upstream, target.upstreamPath);
    await new Promise<void>((resolveRequest, rejectRequest) => {
        const proxyRequest = requestFor(upstreamUrl, {
            headers: proxyHeaders(request.headers, upstreamUrl, mountPath),
            method: request.method ?? "GET"
        }, (proxyResponse) => {
            response.statusCode = proxyResponse.statusCode ?? 502;
            if (proxyResponse.statusMessage !== undefined) response.statusMessage = proxyResponse.statusMessage;
            copyResponseHeaders(proxyResponse.headers, response);
            proxyResponse.pipe(response);
            proxyResponse.once("end", resolveRequest);
            proxyResponse.once("error", rejectRequest);
        });
        proxyRequest.once("error", rejectRequest);
        request.once("aborted", () => proxyRequest.destroy());
        request.pipe(proxyRequest);
    }).catch((error) => {
        if (!response.headersSent) {
            writeError(response, 502, error instanceof Error ? error.message : "Extension WebUI upstream failed");
            return;
        }
        response.destroy(error instanceof Error ? error : undefined);
    });
}

async function proxyUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    target: ResolvedProxyTarget,
    mountPath: string
): Promise<void> {
    const upstreamUrl = resolveUpstreamUrl(target.upstream, target.upstreamPath);
    await new Promise<void>((resolveSocket, rejectSocket) => {
        const proxyRequest = requestFor(upstreamUrl, {
            headers: {
                ...proxyHeaders(request.headers, upstreamUrl, mountPath),
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
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                socket.off("close", finish);
                upstreamSocket.off("close", finish);
                resolveSocket();
            };
            socket.once("close", finish);
            upstreamSocket.once("close", finish);
        });
        proxyRequest.once("response", (proxyResponse) => {
            writeUpgradeResponse(socket, proxyResponse);
            proxyResponse.pipe(socket);
            proxyResponse.once("end", resolveSocket);
        });
        proxyRequest.once("error", rejectSocket);
        proxyRequest.end();
    }).catch((error) => {
        if (!socket.destroyed) {
            rejectUpgrade(socket, 502, error instanceof Error ? error.message : "Extension WebUI upstream failed");
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

function proxyHeaders(headers: IncomingHttpHeaders, upstream: URL, mountPath: string): IncomingHttpHeaders {
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
    next["x-forwarded-prefix"] = mountPath;
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

function requireLoopbackUpstream(value: URL): URL {
    const url = new URL(value.toString());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Extension WebUI upstream must use http or https.");
    }
    const hostname = url.hostname.toLowerCase();
    const loopback = hostname === "localhost"
        || hostname === "::1"
        || hostname === "[::1]"
        || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
    if (!loopback) throw new Error("Extension WebUI upstream must be loopback-only.");
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
    if (response.writableEnded) return;
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: message }));
}

function isBrowserEntryRequest(request: IncomingMessage, suffix: string): boolean {
    const method = (request.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") return false;
    const pathname = new URL(suffix, "http://localhost").pathname;
    return pathname !== "/api" && !pathname.startsWith("/api/");
}

function redirectToLogin(response: ServerResponse, loginPath: string, returnTo: string): void {
    const login = new URL(loginPath, "http://localhost");
    login.searchParams.set("returnTo", returnTo);
    response.statusCode = 302;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Location", `${login.pathname}${login.search}`);
    response.end();
}

function applyStaticSecurityHeaders(response: ServerResponse, filePath: string): void {
    response.setHeader("Content-Security-Policy", [
        "default-src 'self'",
        "base-uri 'none'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "img-src 'self' data:",
        "object-src 'none'",
        "script-src 'self'",
        "style-src 'self'"
    ].join("; "));
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
        "Cache-Control",
        /[/\\]assets[/\\].+\.[A-Za-z0-9]+$/u.test(filePath)
            ? "public, max-age=31536000, immutable"
            : "no-cache"
    );
}

function contentType(filePath: string): string {
    switch (extname(filePath).toLowerCase()) {
        case ".css": return "text/css; charset=utf-8";
        case ".html": return "text/html; charset=utf-8";
        case ".js":
        case ".mjs": return "text/javascript; charset=utf-8";
        case ".json": return "application/json; charset=utf-8";
        case ".svg": return "image/svg+xml";
        case ".png": return "image/png";
        case ".jpg":
        case ".jpeg": return "image/jpeg";
        case ".webp": return "image/webp";
        case ".ico": return "image/x-icon";
        case ".woff": return "font/woff";
        case ".woff2": return "font/woff2";
        default: return "application/octet-stream";
    }
}

function normalizeBasePath(value: string): string {
    const trimmed = value.trim();
    if (!trimmed.startsWith("/")) throw new TypeError("Extension Web base path must be absolute.");
    return trimmed === "/" ? "/" : trimmed.replace(/\/+$/u, "");
}

function normalizeLoginPath(value: string): string {
    const trimmed = value.trim();
    if (!trimmed.startsWith("/")) throw new TypeError("Extension Web login path must be absolute.");
    return `${trimmed.replace(/\/+$/u, "")}/`;
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
    return prefix === "/" || pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isMissing(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
