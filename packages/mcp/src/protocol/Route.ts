import type { IncomingMessage, ServerResponse } from "node:http";
import express, { type Express } from "express";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { JsonValue } from "@portable-devshell/shared";

import type { McpHttpRoute } from "../server/Api.js";
import type { McpAuthConfig } from "../oauth/Config.js";
import { McpAuthProviderToken } from "../oauth/Provider.js";
import type { McpOAuthProtectedResource } from "../oauth/Route.js";
import { McpEndpointBinding } from "./Binding.js";
import { McpEndpoint, type McpEndpointOptions } from "./Endpoint.js";
import { McpExtensionRegistry } from "./extension/Registry.js";
import type { McpExtension } from "./extension/Contract.js";
import { McpHostRouteRegistry, type McpHostRouteEntry } from "./Registry.js";

const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Protocol routes consume HTTP registration; they never create or close listeners. */
export class McpProtocolRoute {
    readonly #registry = new McpHostRouteRegistry();
    readonly #http: McpHttpRoute;
    readonly #oauth?: McpOAuthProtectedResource;
    readonly #publicBaseUrl?: string;
    readonly #releases = new Map<string, () => void>();
    #active = false;

    constructor(
        http: McpHttpRoute,
        options: {
            oauth?: McpOAuthProtectedResource;
            publicBaseUrl?: string;
        } = {},
    ) {
        this.#http = http;
        this.#oauth = options.oauth;
        this.#publicBaseUrl = options.publicBaseUrl;
    }

    /** Each Protocol Route generation owns its Endpoint, extension registry and Binding. */
    registerInstance(
        options: Omit<McpEndpointOptions, "extensions"> & { extensions?: readonly McpExtension[] },
        path: string,
        serverVersion?: string,
    ): void {
        const binding = new McpEndpointBinding(
            new McpEndpoint({
                ...options,
                extensions: new McpExtensionRegistry(options.extensions),
            }),
            serverVersion,
        );
        this.register({
            auth: options.auth ?? { enabled: false, provider: "none" },
            binding,
            path,
        });
    }

    register(entry: { binding: McpEndpointBinding; path: string; auth?: McpAuthConfig }): void {
        if (!this.#active) {
            this.#registry.register(entry);
            return;
        }
        // Mount first: a failed registration must leave the previous Binding
        // and its HTTP routes untouched.
        const release = this.#mount(entry);
        const instance = entry.binding.instanceName;
        try {
            this.#unmount(instance);
            this.#registry.register(entry);
            this.#releases.set(instance, release);
        } catch (error) {
            try { release(); }
            catch (cleanupError) {
                throw new AggregateError([error, cleanupError], "MCP Protocol replacement rollback failed.");
            }
            throw error;
        }
    }

    unregister(instance: string): void {
        this.#unmount(instance);
        this.#registry.unregister(instance);
    }

    start(): void {
        if (this.#active) return;
        try {
            for (const entry of this.#registry.list())
                this.#releases.set(entry.binding.instanceName, this.#mount(entry));
            this.#active = true;
        } catch (error) {
            for (const instance of this.#releases.keys()) this.#unmount(instance);
            throw error;
        }
    }

    stop(): void {
        this.#active = false;
        for (const instance of [...this.#releases.keys()]) this.#unmount(instance);
    }

    list(): McpHostRouteEntry[] {
        return this.#registry.list();
    }

    #unmount(instance: string): void {
        this.#releases.get(instance)?.();
        this.#releases.delete(instance);
    }

    #mount(entry: McpHostRouteEntry): () => void {
        const { auth, binding, path } = entry;
        const releases: Array<() => void> = [];
        const resourceUrl = this.#publicBaseUrl === undefined ? undefined : new URL(this.#publicBaseUrl);
        if (resourceUrl !== undefined) {
            const pathname = resourceUrl.pathname === "/" ? "" : resourceUrl.pathname.replace(/\/+$/u, "");
            resourceUrl.pathname = `${pathname}${path.startsWith("/") ? path : `/${path}`}`;
            resourceUrl.search = "";
            resourceUrl.hash = "";
        }
        let released = false;
        const releaseAll = () => {
            if (released) return;
            released = true;
            const errors: unknown[] = [];
            for (const release of [...releases].reverse()) {
                try { release(); } catch (error) { errors.push(error); }
            }
            if (errors.length > 0)
                throw new AggregateError(errors, "Failed to release MCP Protocol routes.");
        };
        try {
            if (auth?.provider === "oauth2" && this.#oauth !== undefined && resourceUrl !== undefined) {
                releases.push(this.#oauth.registerResource(resourceUrl, auth.oauth2));
                const metadata = `/.well-known/oauth-protected-resource${resourceUrl.pathname === "/" ? "" : resourceUrl.pathname}`;
                releases.push(
                    this.#http.registerRawRoute("get", metadata, (_request, response) => {
                        respond(
                            response,
                            200,
                            this.#oauth!.protectedResourceMetadata(resourceUrl, auth.oauth2),
                        );
                    }),
                );
            }
            const oauthApp =
                auth?.provider === "oauth2" && this.#oauth !== undefined && resourceUrl !== undefined
                    ? express()
                    : undefined;
            if (oauthApp !== undefined && auth?.provider === "oauth2")
                oauthApp.use(this.#oauth!.requestAuthHandler(resourceUrl!, auth.oauth2));
            releases.push(
                this.#http.registerMiddleware(path, (request, response, next) => {
                    // An Express-based test listener strips the mounted prefix from
                    // request.url; the Control HTTP owner preserves the original URL.
                    const original = request as IncomingMessage & { originalUrl?: string };
                    const pathname = new URL(original.originalUrl ?? request.url ?? "/", "http://localhost")
                        .pathname;
                    if (pathname !== path) {
                        next();
                        return;
                    }
                    const dispatch = () => {
                        void this.#dispatch(binding, request, response).catch((error: unknown) => {
                            if (response.headersSent) {
                                response.end();
                                return;
                            }
                            respond(response, error instanceof McpHttpInputError ? error.statusCode : 500, {
                                error:
                                    error instanceof McpHttpInputError
                                        ? error.message
                                        : "Internal server error",
                            });
                        });
                    };
                    if (auth?.provider === "oauth2") {
                        if (this.#oauth === undefined || resourceUrl === undefined) {
                            respond(response, 503, { error: "OAuth authentication is unavailable" });
                            return;
                        }
                        // The bearer verifier is Express middleware; adapt the
                        // native Control request without teaching HTTP about OAuth.
                        oauthApp!(
                            request as Parameters<Express>[0],
                            response as Parameters<Express>[1],
                            dispatch,
                        );
                        return;
                    }
                    if (auth?.provider === "token") {
                        const credential = new McpAuthProviderToken(auth.token).authenticate(
                            request.headers.authorization,
                        );
                        if (credential === undefined) {
                            respond(response, 401, { error: "Unauthorized" });
                            return;
                        }
                        setAuth(request, credential);
                    } else {
                        setAuth(request, { clientId: "local", scopes: [], token: "local" });
                    }
                    dispatch();
                }),
            );
        } catch (error) {
            try { releaseAll(); }
            catch (cleanupError) {
                throw new AggregateError([error, cleanupError], "MCP Protocol mount and rollback failed.");
            }
            throw error;
        }
        return releaseAll;
    }

    async #dispatch(
        binding: McpEndpointBinding,
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        const body = await readJsonBody(request);
        await binding.handleRequest(request, response, body);
    }
}

function setAuth(request: IncomingMessage, auth: AuthInfo): void {
    (request as IncomingMessage & { auth?: AuthInfo }).auth = auth;
}

function respond(response: ServerResponse, code: number, body: unknown): void {
    if (response.headersSent) {
        response.end();
        return;
    }
    response.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
}

class McpHttpInputError extends Error {
    constructor(
        readonly statusCode: 400 | 413,
        message: string,
    ) {
        super(message);
    }
}

async function readJsonBody(request: IncomingMessage): Promise<JsonValue> {
    const header = request.headers["content-length"];
    const encoded = Array.isArray(header) ? header[0] : header;
    if (encoded !== undefined && /^\d+$/u.test(encoded) && Number(encoded) > MAX_BODY_BYTES) {
        request.resume();
        throw new McpHttpInputError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > MAX_BODY_BYTES) {
            request.resume();
            throw new McpHttpInputError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes.`);
        }
        chunks.push(bytes);
    }
    if (chunks.length === 0) return {};
    try {
        const body: unknown = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
        return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as JsonValue) : {};
    } catch {
        throw new McpHttpInputError(400, "Request body must contain valid JSON.");
    }
}
