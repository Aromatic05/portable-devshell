import { createServer, type IncomingMessage, type Server } from "node:http";

import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";

import type { McpAuthConfig } from "../auth/McpAuthConfig.js";
import { McpAuthProviderToken } from "../auth/provider/McpAuthProviderToken.js";
import { McpOAuthProtectedResource } from "../auth/oauth/McpOAuthProtectedResource.js";
import { McpEndpointBinding } from "../endpoint/McpEndpointBinding.js";

type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

interface McpHostHttpServerOptions {
    auth?: McpAuthConfig;
    listenHost: string;
    listenPort: number;
    oauth?: McpOAuthProtectedResource;
    publicBaseUrl?: string;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class McpHostHttpServer {
    readonly #app = express();
    readonly #auth?: McpAuthConfig;
    readonly #listenHost: string;
    readonly #listenPort: number;
    readonly #oauth?: McpOAuthProtectedResource;
    #oauthInstalled = false;
    readonly #publicBaseUrl?: string;
    readonly #registeredPaths = new Set<string>();
    readonly #tokenProvider = new McpAuthProviderToken();
    #server?: Server;

    constructor(options: McpHostHttpServerOptions) {
        this.#auth = options.auth;
        this.#listenHost = options.listenHost;
        this.#listenPort = options.listenPort;
        this.#oauth = options.oauth;
        this.#publicBaseUrl = options.publicBaseUrl;

        this.#app.disable("x-powered-by");
    }

    async start(): Promise<void> {
        if (this.#server !== undefined) {
            return;
        }

        if (this.#oauth !== undefined && !this.#oauthInstalled) {
            this.#oauth.install(this.#app);
            this.#oauthInstalled = true;
        }

        this.#server = createServer(this.#app);

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
        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });
    }

    get address() {
        return this.#server?.address();
    }

    registerBinding(path: string, binding: McpEndpointBinding): void {
        if (this.#registeredPaths.has(path)) {
            return;
        }

        this.#registeredPaths.add(path);

        const routeHandlers: RequestHandler[] = [];
        const resourceServerUrl = this.#toPublicResourceUrl(path);

        if (this.#auth?.provider === "oauth2" && this.#oauth !== undefined && resourceServerUrl !== undefined) {
            this.#oauth.registerResource(resourceServerUrl);
            routeHandlers.push(this.#oauth.requestAuthHandler(resourceServerUrl));
            this.#app.use(this.#oauthProtectedResourceMetadataPath(resourceServerUrl), this.#oauth.protectedResourceMetadataHandler(resourceServerUrl));
        } else if (this.#auth?.provider === "token") {
            routeHandlers.push((request: Request, response: Response, next: NextFunction) => {
                const authorized = this.#tokenProvider.authorize(request.headers.authorization);

                if (!authorized) {
                    response.status(401).json({ error: "Unauthorized" });
                    return;
                }

                next();
            });
        }

        this.#app.all(path, ...routeHandlers, async (request: Request, response: Response) => {
            const body = await this.#readJsonBody(request as IncomingMessage);
            await binding.handleRequest(request, response, body);
        });
    }

    async #readJsonBody(request: IncomingMessage): Promise<JsonValue> {
        const chunks: Buffer[] = [];

        for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }

        if (chunks.length === 0) {
            return {};
        }

        const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
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

function joinUrlPaths(basePathname: string, nextPathname: string): string {
    const base = basePathname === "/" ? "" : basePathname.replace(/\/+$/u, "");
    const next = nextPathname.startsWith("/") ? nextPathname : `/${nextPathname}`;
    return `${base}${next}`;
}
