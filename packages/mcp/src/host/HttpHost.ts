import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import type { McpAuthConfig } from "../auth/McpAuthConfig.js";
import { McpAuthProviderToken } from "../auth/provider/McpAuthProviderToken.js";
import { McpOAuthProtectedResource } from "../auth/oauth/McpOAuthProtectedResource.js";
import { McpEndpointBinding } from "../endpoint/McpEndpointBinding.js";

type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

export interface HttpHostOptions {
    auth?: McpAuthConfig;
    listenHost: string;
    listenPort: number;
    oauth?: McpOAuthProtectedResource;
    publicBaseUrl?: string;
    shutdownGraceMs?: number;
}

const MCP_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MCP_HEADERS_TIMEOUT_MS = 10_000;
const MCP_REQUEST_TIMEOUT_MS = 30_000;
const MCP_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const MCP_SHUTDOWN_GRACE_MS = 10_000;
const MCP_FORCE_CLOSE_WAIT_MS = 1_000;

function isRecord(value: unknown): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class HttpHost {
    readonly #app = express();
    readonly #auth?: McpAuthConfig;
    readonly #bindings = new Map<string, { auth?: McpAuthConfig; binding: McpEndpointBinding }>();
    readonly #listenHost: string;
    readonly #listenPort: number;
    readonly #oauth?: McpOAuthProtectedResource;
    readonly #installedOAuth = new Set<McpOAuthProtectedResource>();
    #oauthInstalled = false;
    readonly #publicBaseUrl?: string;
    readonly #registeredPaths = new Set<string>();
    readonly #shutdownGraceMs: number;
    readonly #sockets = new Set<Duplex>();
    readonly #upgradeHandlers = new Map<
        string,
        (request: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
    >();
    #server?: Server;

    constructor(options: HttpHostOptions) {
        this.#auth = options.auth;
        this.#listenHost = options.listenHost;
        this.#listenPort = options.listenPort;
        this.#oauth = options.oauth;
        this.#publicBaseUrl = options.publicBaseUrl;
        this.#shutdownGraceMs = options.shutdownGraceMs ?? MCP_SHUTDOWN_GRACE_MS;
        this.#app.disable("x-powered-by");
    }

    async start(): Promise<void> {
        if (this.#server !== undefined) {
            return;
        }

        if (this.#oauth !== undefined && this.#usesOAuth()) {
            this.#installPrimaryOAuth();
        }

        this.#server = createServer({ maxHeaderSize: 16 * 1024 }, this.#app);
        this.#server.headersTimeout = MCP_HEADERS_TIMEOUT_MS;
        this.#server.requestTimeout = MCP_REQUEST_TIMEOUT_MS;
        this.#server.keepAliveTimeout = MCP_KEEP_ALIVE_TIMEOUT_MS;
        this.#server.on("connection", (socket) => {
            this.#sockets.add(socket);
            socket.once("close", () => this.#sockets.delete(socket));
        });
        this.#server.on("upgrade", (request, socket, head) => {
            const pathname = readRequestPathname(request);
            const handler = pathname === undefined ? undefined : this.#upgradeHandlers.get(pathname);
            if (handler === undefined) {
                socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
                return;
            }
            void Promise.resolve(handler(request, socket, head)).catch(() => {
                socket.destroy();
            });
        });

        await new Promise<void>((resolve, reject) => {
            this.#server?.once("error", reject);
            this.#server?.listen(this.#listenPort, this.#listenHost, () => resolve());
        });
    }

    async stop(): Promise<void> {
        if (this.#server === undefined) {
            return;
        }

        const server = this.#server;
        this.#server = undefined;
        const closed = new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });
        server.closeIdleConnections();
        const graceful = await Promise.race([
            closed.then(() => true),
            delay(this.#shutdownGraceMs).then(() => false)
        ]);
        if (graceful) {
            this.#destroyOpenSockets();
            return;
        }

        this.#destroyOpenSockets();
        server.closeAllConnections();
        await Promise.race([
            closed,
            delay(MCP_FORCE_CLOSE_WAIT_MS)
        ]);
    }

    #destroyOpenSockets(): void {
        for (const socket of this.#sockets) {
            socket.destroy();
        }
        this.#sockets.clear();
    }

    get address() {
        return this.#server?.address();
    }

    installOAuth(oauth: McpOAuthProtectedResource): void {
        if (this.#installedOAuth.has(oauth)) {
            return;
        }
        oauth.install(this.#app);
        this.#installedOAuth.add(oauth);
    }

    registerRawRoute(
        method: "delete" | "get" | "head" | "options" | "post",
        path: string,
        handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
    ): () => void {
        let active = true;
        this.#app[method](path, (request: Request, response: Response, next: NextFunction) => {
            if (!active) {
                next();
                return;
            }
            void Promise.resolve(handler(request as IncomingMessage, response as unknown as ServerResponse)).catch(
                (error: unknown) => {
                    if (!response.headersSent) {
                        response.status(500).json({
                            error: error instanceof Error ? error.message : "Internal server error"
                        });
                        return;
                    }
                    response.end();
                }
            );
        });
        return () => {
            active = false;
        };
    }

    registerAuthenticatedRawRoute(
        method: "delete" | "get" | "head" | "post",
        path: string,
        handler: (
            request: IncomingMessage,
            response: ServerResponse,
            auth: AuthInfo
        ) => void | Promise<void>
    ): () => void {
        let active = true;
        this.#app[method](path, ...this.#createAuthHandlers(path), (request: Request, response: Response, next: NextFunction) => {
            if (!active) {
                next();
                return;
            }
            const auth = readRequestAuth(request);
            if (auth === undefined) {
                response.status(401).json({ error: "Unauthorized" });
                return;
            }
            void Promise.resolve(
                handler(request as IncomingMessage, response as unknown as ServerResponse, auth)
            ).catch((error: unknown) => {
                if (!response.headersSent) {
                    response.status(500).json({
                        error: error instanceof Error ? error.message : "Internal server error"
                    });
                    return;
                }
                response.end();
            });
        });
        return () => {
            active = false;
        };
    }

    registerStaticDirectory(path: string, directory: string): () => void {
        let active = true;
        const staticDirectory = express.static(directory, {
            fallthrough: false,
            index: "index.html",
            redirect: true,
            setHeaders: (response, filePath) => {
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
                if (/[/\\]assets[/\\].+\.[A-Za-z0-9]+$/u.test(filePath)) {
                    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
                    return;
                }
                response.setHeader("Cache-Control", "no-cache");
            }
        });
        this.#app.use(path, (request: Request, response: Response, next: NextFunction) => {
            if (!active) {
                next();
                return;
            }
            staticDirectory(request, response, next);
        });
        return () => {
            active = false;
        };
    }

    registerUpgradeHandler(
        path: string,
        handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
    ): () => void {
        this.#upgradeHandlers.set(path, handler);
        return () => {
            if (this.#upgradeHandlers.get(path) === handler) {
                this.#upgradeHandlers.delete(path);
            }
        };
    }

    registerBinding(path: string, binding: McpEndpointBinding, auth?: McpAuthConfig): void {
        this.#bindings.set(path, { auth, binding });
        const resourceServerUrl = this.#toPublicResourceUrl(path);
        const activateOAuth = auth?.provider === "oauth2" && this.#oauth !== undefined && resourceServerUrl !== undefined;
        if (activateOAuth) {
            this.#oauth!.registerResource(resourceServerUrl!, auth.oauth2);
        }
        if (this.#registeredPaths.has(path)) {
            if (activateOAuth && this.#server !== undefined) {
                this.#installPrimaryOAuth();
            }
            return;
        }

        this.#registeredPaths.add(path);
        if (resourceServerUrl !== undefined && this.#oauth !== undefined) {
            this.#app.get(this.#oauthProtectedResourceMetadataPath(resourceServerUrl), (request: Request, response: Response) => {
                const current = this.#bindings.get(path);
                if (current?.auth?.provider !== "oauth2") {
                    response.status(404).json({ error: "OAuth protected resource not found" });
                    return;
                }
                response.json(this.#oauth!.protectedResourceMetadata(resourceServerUrl, current.auth.oauth2));
            });
        }

        this.#app.all(path, this.#bindingAuthHandler(path), async (request: Request, response: Response) => {
            try {
                const current = this.#bindings.get(path);
                if (current === undefined) {
                    response.status(404).json({ error: "Instance endpoint not found" });
                    return;
                }
                const body = await this.#readJsonBody(request as IncomingMessage);
                await current.binding.handleRequest(request, response, body);
            } catch (error) {
                if (response.headersSent) {
                    response.end();
                    return;
                }
                if (error instanceof McpHttpInputError) {
                    response.status(error.statusCode).json({ error: error.message });
                    return;
                }
                response.status(500).json({ error: "Internal server error" });
            }
        });
        if (activateOAuth && this.#server !== undefined) {
            this.#installPrimaryOAuth();
        }
    }

    unregisterBinding(path: string): void {
        this.#bindings.delete(path);
    }

    #createAuthHandlers(path: string): RequestHandler[] {
        const routeHandlers: RequestHandler[] = [];
        const resourceServerUrl = this.#toPublicResourceUrl(path);
        const auth = this.#bindings.get(path)?.auth ?? this.#auth;

        if (auth?.provider === "oauth2" && this.#oauth !== undefined && resourceServerUrl !== undefined) {
            this.#oauth.registerResource(resourceServerUrl, auth.oauth2);
            routeHandlers.push(this.#oauth.requestAuthHandler(resourceServerUrl, auth.oauth2));
            this.#app.use(
                this.#oauthProtectedResourceMetadataPath(resourceServerUrl),
                this.#oauth.protectedResourceMetadataHandler(resourceServerUrl, auth.oauth2)
            );
        } else if (auth?.provider === "oauth2") {
            routeHandlers.push((_request: Request, response: Response) => {
                response.status(503).json({ error: "OAuth authentication is unavailable" });
            });
        } else if (auth?.provider === "token") {
            routeHandlers.push((request: Request, response: Response, next: NextFunction) => {
                const requestAuth = new McpAuthProviderToken(auth.token).authenticate(request.headers.authorization);
                if (requestAuth === undefined) {
                    response.status(401).json({ error: "Unauthorized" });
                    return;
                }
                setRequestAuth(request, requestAuth);
                next();
            });
        } else {
            routeHandlers.push((request: Request, _response: Response, next: NextFunction) => {
                setRequestAuth(request, { clientId: "local", scopes: [], token: "local" });
                next();
            });
        }
        return routeHandlers;
    }

    #bindingAuthHandler(path: string): RequestHandler {
        return (request: Request, response: Response, next: NextFunction) => {
            const current = this.#bindings.get(path);
            const auth = current?.auth ?? { enabled: false as const, provider: "none" as const };
            const resourceServerUrl = this.#toPublicResourceUrl(path);
            if (auth.provider === "oauth2" && this.#oauth !== undefined && resourceServerUrl !== undefined) {
                void this.#oauth.requestAuthHandler(resourceServerUrl, auth.oauth2)(request, response, next);
                return;
            }
            if (auth.provider === "oauth2") {
                response.status(503).json({ error: "OAuth authentication is unavailable" });
                return;
            }
            if (auth.provider === "token") {
                const requestAuth = new McpAuthProviderToken(auth.token).authenticate(request.headers.authorization);
                if (requestAuth === undefined) {
                    response.status(401).json({ error: "Unauthorized" });
                    return;
                }
                setRequestAuth(request, requestAuth);
                next();
                return;
            }
            setRequestAuth(request, { clientId: "local", scopes: [], token: "local" });
            next();
        };
    }

    #installPrimaryOAuth(): void {
        if (this.#oauth === undefined || this.#oauthInstalled) {
            return;
        }
        this.installOAuth(this.#oauth);
        this.#oauthInstalled = true;
    }

    #usesOAuth(): boolean {
        if (this.#auth?.provider === "oauth2") {
            return true;
        }
        return [...this.#bindings.values()].some((binding) => binding.auth?.provider === "oauth2");
    }

    async #readJsonBody(request: IncomingMessage): Promise<JsonValue> {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        const contentLength = readContentLength(request.headers["content-length"]);
        if (contentLength !== undefined && contentLength > MCP_MAX_REQUEST_BODY_BYTES) {
            request.resume();
            throw new McpHttpInputError(413, `Request body exceeds ${MCP_MAX_REQUEST_BODY_BYTES} bytes.`);
        }

        for await (const chunk of request) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += bytes.length;
            if (totalBytes > MCP_MAX_REQUEST_BODY_BYTES) {
                request.resume();
                throw new McpHttpInputError(413, `Request body exceeds ${MCP_MAX_REQUEST_BODY_BYTES} bytes.`);
            }
            chunks.push(bytes);
        }

        if (chunks.length === 0) {
            return {};
        }

        let value: unknown;
        try {
            value = JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8")) as unknown;
        } catch {
            throw new McpHttpInputError(400, "Request body must contain valid JSON.");
        }
        return isRecord(value) ? value : {};
    }

    #oauthProtectedResourceMetadataPath(resourceServerUrl: URL): string {
        const pathname = resourceServerUrl.pathname;
        return `/.well-known/oauth-protected-resource${pathname === "/" ? "" : pathname}`;
    }

    #toPublicResourceUrl(path: string): URL | undefined {
        if (this.#publicBaseUrl === undefined) {
            return undefined;
        }

        const url = new URL(this.#publicBaseUrl);
        url.pathname = joinUrlPaths(url.pathname, path);
        url.search = "";
        url.hash = "";
        return url;
    }
}

class McpHttpInputError extends Error {
    constructor(readonly statusCode: 400 | 413, message: string) {
        super(message);
    }
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, milliseconds));
        timer.unref();
    });
}

function readContentLength(value: string | string[] | undefined): number | undefined {
    const source = Array.isArray(value) ? value[0] : value;
    if (source === undefined || !/^\d+$/u.test(source)) {
        return undefined;
    }
    const parsed = Number(source);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function readRequestPathname(request: IncomingMessage): string | undefined {
    if (request.url === undefined) {
        return undefined;
    }
    try {
        return new URL(request.url, "http://localhost").pathname;
    } catch {
        return undefined;
    }
}

function joinUrlPaths(basePathname: string, nextPathname: string): string {
    const base = basePathname === "/" ? "" : basePathname.replace(/\/+$/u, "");
    const next = nextPathname.startsWith("/") ? nextPathname : `/${nextPathname}`;
    return `${base}${next}`;
}

function setRequestAuth(request: Request, auth: AuthInfo): void {
    (request as Request & { auth?: AuthInfo }).auth = auth;
}

function readRequestAuth(request: Request): AuthInfo | undefined {
    return (request as Request & { auth?: AuthInfo }).auth;
}
