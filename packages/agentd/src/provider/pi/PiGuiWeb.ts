import {
    createServer,
    request as httpRequest,
    type IncomingHttpHeaders,
    type IncomingMessage,
    type Server,
    type ServerResponse
} from "node:http";

import type { PiSessionLike } from "./PiSdkLoader.js";

const MAX_REWRITE_BYTES = 64 * 1024 * 1024;
const MANAGED_ERROR = "This Pi GUI is managed by devshell; create and manage sessions with devshell agent.";

interface PiGuiHubLike {
    attach(session: unknown, options?: { cwd?: string }): { id: string };
    detach(id: string): boolean;
    disposeAll(): Promise<void>;
    ensure(ref: string): Promise<unknown>;
    list(cwd?: string): Promise<unknown[]>;
    listOpen(): unknown[];
    open(options?: unknown): Promise<unknown>;
    require(id: string): unknown;
}

interface PiGuiServerLike {
    close(): Promise<void>;
    listen(callback?: () => void): Server;
    server: Server;
}

interface PiGuiHttpModule {
    createServer(options?: { port?: number; stayAlive?: boolean }): PiGuiServerLike;
}

interface PiGuiHubModule {
    hub: PiGuiHubLike;
}

export class PiGuiWeb {
    readonly #basePath: string;
    readonly #hub: PiGuiHubLike;
    readonly #proxy: Server;
    readonly #raw: PiGuiServerLike;
    readonly upstream: URL;

    private constructor(options: {
        basePath: string;
        hub: PiGuiHubLike;
        proxy: Server;
        raw: PiGuiServerLike;
        upstream: URL;
    }) {
        this.#basePath = options.basePath;
        this.#hub = options.hub;
        this.#proxy = options.proxy;
        this.#raw = options.raw;
        this.upstream = options.upstream;
    }

    static async start(basePath: string): Promise<PiGuiWeb> {
        const normalizedBasePath = normalizeBasePath(basePath);
        const [httpModule, hubModule] = await Promise.all([
            importModule("pi-gui-extension/server/http.js"),
            importModule("pi-gui-extension/server/hub.js")
        ]);
        const http = requireHttpModule(httpModule);
        const hub = requireHubModule(hubModule).hub;
        restrictHubToAttachedSessions(hub);

        const raw = http.createServer({ port: 0, stayAlive: true });
        await listen(raw.server, () => raw.listen());
        const rawPort = requirePort(raw.server);

        const proxy = createServer((request, response) => {
            void proxyPiGuiRequest(request, response, {
                basePath: normalizedBasePath,
                rawPort
            });
        });
        await listen(proxy, () => proxy.listen(0, "127.0.0.1"));
        const proxyPort = requirePort(proxy);
        return new PiGuiWeb({
            basePath: normalizedBasePath,
            hub,
            proxy,
            raw,
            upstream: new URL(`http://127.0.0.1:${proxyPort}/`)
        });
    }

    attach(session: PiSessionLike, cwd: string): string {
        return this.#hub.attach(session, { cwd }).id;
    }

    detach(session: PiSessionLike): void {
        this.#hub.detach(session.sessionId);
    }

    async stop(): Promise<void> {
        await closeServer(this.#proxy);
        await this.#hub.disposeAll();
        await closeServer(this.#raw.server);
    }

    get basePath(): string {
        return this.#basePath;
    }
}

function restrictHubToAttachedSessions(hub: PiGuiHubLike): void {
    hub.list = async () => hub.listOpen();
    hub.ensure = async (ref: string) => hub.require(ref);
    hub.open = async () => {
        throw new Error(MANAGED_ERROR);
    };
}

async function proxyPiGuiRequest(
    request: IncomingMessage,
    response: ServerResponse,
    options: { basePath: string; rawPort: number }
): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!isManagedPiGuiRequest(request.method ?? "GET", url.pathname)) {
        response.statusCode = 403;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ error: MANAGED_ERROR }));
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const headers = proxyRequestHeaders(request.headers, options.rawPort);
        const upstream = httpRequest({
            headers,
            host: "127.0.0.1",
            method: request.method,
            path: request.url,
            port: options.rawPort
        }, (upstreamResponse) => {
            const contentType = String(upstreamResponse.headers["content-type"] ?? "");
            if (shouldRewrite(contentType)) {
                void rewriteResponse(upstreamResponse, response, options.basePath).then(resolve, reject);
                return;
            }
            response.statusCode = upstreamResponse.statusCode ?? 502;
            copyHeaders(upstreamResponse.headers, response);
            upstreamResponse.pipe(response);
            upstreamResponse.once("end", resolve);
            upstreamResponse.once("error", reject);
        });
        upstream.once("error", reject);
        request.once("aborted", () => upstream.destroy());
        request.pipe(upstream);
    }).catch((error) => {
        if (!response.headersSent) {
            response.statusCode = 502;
            response.setHeader("content-type", "application/json; charset=utf-8");
            response.end(JSON.stringify({
                error: error instanceof Error ? error.message : "Pi GUI upstream failed"
            }));
            return;
        }
        response.destroy(error instanceof Error ? error : undefined);
    });
}

async function rewriteResponse(
    upstream: IncomingMessage,
    response: ServerResponse,
    basePath: string
): Promise<void> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of upstream) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += data.length;
        if (size > MAX_REWRITE_BYTES) throw new Error("Pi GUI asset exceeds rewrite limit.");
        chunks.push(data);
    }
    const body = rewritePiGuiAsset(Buffer.concat(chunks).toString("utf8"), basePath);
    response.statusCode = upstream.statusCode ?? 200;
    copyHeaders(upstream.headers, response, new Set(["content-length", "content-encoding", "transfer-encoding"]));
    response.setHeader("content-length", Buffer.byteLength(body));
    response.end(body);
}

export function rewritePiGuiAsset(source: string, basePath: string): string {
    const base = normalizeBasePath(basePath);
    let output = source;
    for (const root of ["api/", "assets/", "favicon.svg"]) {
        const from = `/${root}`;
        const to = `${base}${root}`;
        output = output.replaceAll(from, to);
    }
    output = output.replace(/return`\/`\+([A-Za-z_$][\w$]*)/gu, `return\`${escapeTemplate(base)}\`+$1`);
    output = output.replace(/return"\/"\+([A-Za-z_$][\w$]*)/gu, `return"${escapeDoubleQuoted(base)}"+$1`);
    return output;
}

export function isManagedPiGuiRequest(method: string, pathname: string): boolean {
    const normalizedMethod = method.toUpperCase();
    if (!pathname.startsWith("/api")) return normalizedMethod === "GET" || normalizedMethod === "HEAD";
    if (normalizedMethod === "OPTIONS") return true;

    if (normalizedMethod === "GET" && new Set([
        "/api/health",
        "/api/changelog",
        "/api/customization",
        "/api/customization/asset",
        "/api/models",
        "/api/sessions"
    ]).has(pathname)) return true;

    const match = /^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/u.exec(pathname);
    if (match === null) return false;
    const action = match[2];
    if (action === undefined) return normalizedMethod === "GET" || normalizedMethod === "PATCH";

    if (normalizedMethod === "GET") {
        return new Set([
            "messages",
            "scoped-models",
            "thinking",
            "tree",
            "fork",
            "tools",
            "extensions",
            "commands",
            "events"
        ]).has(action);
    }
    if (normalizedMethod === "POST") {
        return new Set([
            "prompt",
            "abort",
            "model",
            "scoped-models",
            "thinking",
            "compact",
            "tree",
            "steer",
            "follow-up",
            "tools"
        ]).has(action);
    }
    return false;
}

function normalizeBasePath(value: string): string {
    const trimmed = value.trim();
    if (!trimmed.startsWith("/")) throw new TypeError("Pi GUI base path must be absolute.");
    return `${trimmed.replace(/\/+$/u, "")}/`;
}

function proxyRequestHeaders(headers: IncomingHttpHeaders, port: number): IncomingHttpHeaders {
    const next = { ...headers };
    delete next["accept-encoding"];
    delete next.host;
    next.host = `127.0.0.1:${port}`;
    return next;
}

function copyHeaders(
    headers: IncomingHttpHeaders,
    response: ServerResponse,
    excluded: ReadonlySet<string> = new Set()
): void {
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined || excluded.has(name.toLowerCase())) continue;
        response.setHeader(name, value);
    }
}

function shouldRewrite(contentType: string): boolean {
    return contentType.includes("text/html")
        || contentType.includes("javascript")
        || contentType.includes("text/css");
}

function listen(server: Server, start: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
            server.off("listening", onListening);
            reject(error);
        };
        const onListening = () => {
            server.off("error", onError);
            resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        start();
    });
}

function requirePort(server: Server): number {
    const address = server.address();
    if (typeof address !== "object" || address === null) {
        throw new Error("Pi GUI failed to bind a loopback TCP port.");
    }
    return address.port;
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections();
        server.closeAllConnections();
    });
}

function requireHttpModule(value: unknown): PiGuiHttpModule {
    if (typeof value !== "object" || value === null || typeof (value as { createServer?: unknown }).createServer !== "function") {
        throw new Error("pi-gui-extension does not expose createServer().");
    }
    return value as PiGuiHttpModule;
}

function requireHubModule(value: unknown): PiGuiHubModule {
    if (typeof value !== "object" || value === null) throw new Error("pi-gui-extension hub module is invalid.");
    const hub = (value as { hub?: unknown }).hub;
    if (typeof hub !== "object" || hub === null) throw new Error("pi-gui-extension does not expose its session hub.");
    for (const method of ["attach", "detach", "disposeAll", "ensure", "list", "listOpen", "open", "require"] as const) {
        if (typeof (hub as Record<string, unknown>)[method] !== "function") {
            throw new Error(`pi-gui-extension hub is missing ${method}().`);
        }
    }
    return { hub: hub as PiGuiHubLike };
}

async function importModule(specifier: string): Promise<unknown> {
    return await import(specifier);
}

function escapeTemplate(value: string): string {
    return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
}

function escapeDoubleQuoted(value: string): string {
    return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
