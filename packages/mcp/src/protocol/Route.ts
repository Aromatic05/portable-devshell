import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import express, { type Express } from "express";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { JsonValue } from "@portable-devshell/shared";

import type { McpHttpRoute } from "../server/Api.js";
import type { McpAuthConfig } from "../oauth/Config.js";
import { McpAuthProviderToken } from "../oauth/Provider.js";
import type { McpOAuthProtectedResource } from "../oauth/Route.js";
import { McpEndpointBinding } from "./Binding.js";
import type { McpEndpointOptions } from "./Endpoint.js";
import { McpEndpoint } from "./Endpoint.js";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MCP_DRAIN_TIMEOUT_MS = 5_000;

export interface McpHostRouteEntry {
    auth?: McpAuthConfig;
    binding: McpEndpointBinding;
    path: string;
}

export function createMcpRouteEntries(
    options: McpEndpointOptions,
    paths: readonly string[],
    serverVersion?: string,
): McpHostRouteEntry[] {
    const endpoint = new McpEndpoint(options);
    return paths.map((path) => ({
        auth: options.auth,
        binding: new McpEndpointBinding(endpoint, serverVersion, options.modelOutput),
        path,
    }));
}

interface McpInstanceRoutes {
    entries: readonly McpHostRouteEntry[];
    release?: () => void;
}

interface AcceptedMcpRequest {
    done: Promise<void>;
    response: ServerResponse;
}

/** Protocol routes consume HTTP registration; they never create or close listeners. */
export class McpProtocolRoute {
    readonly #instances = new Map<string, McpInstanceRoutes>();
    readonly #inFlight = new Set<AcceptedMcpRequest>();
    readonly #http: McpHttpRoute;
    readonly #oauth?: McpOAuthProtectedResource;
    readonly #publicBaseUrl?: string;
    readonly #requestLogger?: (line: string) => void;
    #active = false;

    constructor(
        http: McpHttpRoute,
        options: {
            oauth?: McpOAuthProtectedResource;
            publicBaseUrl?: string;
            requestLogger?: (line: string) => void;
        } = {},
    ) {
        this.#http = http;
        this.#oauth = options.oauth;
        this.#publicBaseUrl = options.publicBaseUrl;
        this.#requestLogger = options.requestLogger;
    }

    register(instance: string, entries: readonly McpHostRouteEntry[]): void {
        const paths = new Set<string>();
        for (const [name, group] of this.#instances) {
            if (name !== instance) {
                for (const entry of group.entries) paths.add(entry.path);
            }
        }
        if (entries.length === 0) throw new Error("MCP instance requires at least one route.");
        for (const { binding, path } of entries) {
            if (binding.instanceName !== instance) throw new Error("MCP route belongs to a different instance.");
            if (!path.startsWith("/") || path.startsWith("//") ||
                new URL(path, "http://localhost").pathname !== path)
                throw new Error(`Invalid MCP route path: ${path}`);
            if (paths.has(path)) throw new Error(`Duplicate MCP route path: ${path}`);
            paths.add(path);
        }
        const next: McpInstanceRoutes = { entries: [...entries] };
        // Install the whole candidate synchronously, retaining the previous
        // handlers if any HTTP or OAuth registration fails.
        if (this.#active) next.release = this.#mountGroup(next.entries);
        const previous = this.#instances.get(instance);
        this.#instances.set(instance, next);
        previous?.release?.();
    }

    unregister(instance: string): void {
        const group = this.#instances.get(instance);
        this.#instances.delete(instance);
        group?.release?.();
    }

    start(): void {
        if (this.#active) return;
        try {
            for (const group of this.#instances.values()) group.release = this.#mountGroup(group.entries);
            this.#active = true;
        } catch (error) {
            rollbackRoutes(error, [() => this.stop()]);
        }
    }

    stop(): void {
        this.#active = false;
        const releases = [];
        for (const group of this.#instances.values()) {
            if (group.release !== undefined) releases.push(group.release);
            group.release = undefined;
        }
        releaseRoutes(releases);
    }

    /**
     * Stop admission via stop() first; then wait for responses accepted by
     * this generation. Hot replacement deliberately does not call drain().
     * A final shutdown may bound the grace period and close only stragglers.
     */
    async drain(options: { timeoutMs?: number; force?: boolean } = {}): Promise<void> {
        const timeoutMs = options.timeoutMs ?? MCP_DRAIN_TIMEOUT_MS;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
            throw new TypeError("MCP drain timeout must be a non-negative safe integer.");
        }
        const accepted = [...this.#inFlight];
        if (accepted.length === 0) return;
        const done = Promise.all(accepted.map((entry) => entry.done));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([
            done.then(() => false),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(true), timeoutMs);
            }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        if (!timedOut) return;
        if (!options.force) {
            throw new Error(`MCP generation still has ${this.#inFlight.size} in-flight response(s).`);
        }
        for (const entry of accepted) {
            if (this.#inFlight.has(entry)) {
                entry.response.destroy(new Error("MCP generation final shutdown grace expired."));
            }
        }
        await done;
    }

    #accept(response: ServerResponse): void {
        let finish!: () => void;
        const done = new Promise<void>((resolve) => { finish = resolve; });
        const accepted: AcceptedMcpRequest = { done, response };
        const complete = () => {
            if (!this.#inFlight.delete(accepted)) return;
            response.off("finish", complete);
            response.off("close", complete);
            finish();
        };
        this.#inFlight.add(accepted);
        response.once("finish", complete);
        response.once("close", complete);
    }

    list(): McpHostRouteEntry[] {
        return [...this.#instances.values()].flatMap((group) => group.entries);
    }

    instanceNames(): string[] {
        return [...this.#instances.keys()];
    }

    #mountGroup(entries: readonly McpHostRouteEntry[]): () => void {
        const releases: Array<() => void> = [];
        try {
            for (const entry of entries) releases.push(this.#mount(entry));
        } catch (error) {
            rollbackRoutes(error, releases);
        }
        return () => releaseRoutes(releases);
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
        const requestPath = resourceUrl?.pathname ?? path;
        let released = false;
        const releaseAll = () => {
            if (released) return;
            released = true;
            releaseRoutes(releases);
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
                this.#http.registerMiddleware(requestPath, (request, response, next) => {
                    // An Express-based test listener strips the mounted prefix from
                    // request.url; the Control HTTP owner preserves the original URL.
                    const original = request as IncomingMessage & { originalUrl?: string };
                    const pathname = new URL(original.originalUrl ?? request.url ?? "/", "http://localhost")
                        .pathname;
                    if (pathname !== requestPath) {
                        next();
                        return;
                    }
                    const requestId = randomUUID();
                    const startedAt = performance.now();
                    const httpMethod = request.method ?? "UNKNOWN";
                    const version = traceField(request.headers["mcp-protocol-version"]);
                    let rpcMethod = "unknown";
                    let authenticated = false;
                    let inputError: string | undefined;
                    let finished = false;
                    const report = (event: "received" | "finished") => {
                        try {
                            this.#requestLogger?.(JSON.stringify({
                                event,
                                requestId,
                                instance: binding.instanceName,
                                httpMethod,
                                path: requestPath,
                                protocolVersion: version,
                                ...(event === "finished" ? {
                                    rpcMethod,
                                    auth: authenticated ? "accepted" : response.statusCode === 401 || response.statusCode === 403 ? "rejected" : "not_completed",
                                    status: response.statusCode,
                                    durationMs: Math.round(performance.now() - startedAt),
                                    ...(inputError === undefined ? {} : { error: inputError }),
                                    completed: response.writableFinished,
                                } : {}),
                            }));
                        } catch {
                            // Diagnostics must not affect MCP requests.
                        }
                    };
                    report("received");
                    const finishReport = () => {
                        if (finished) return;
                        finished = true;
                        response.off("finish", finishReport);
                        response.off("close", finishReport);
                        report("finished");
                    };
                    response.once("finish", finishReport);
                    response.once("close", finishReport);
                    if (released) {
                        respond(response, 503, { error: "MCP generation no longer accepts requests" });
                        return;
                    }
                    // Count from admission through HTTP response completion,
                    // including OAuth verification, body parsing and SSE.
                    this.#accept(response);
                    const dispatch = () => {
                        authenticated = true;
                        void this.#dispatch(binding, request, response, (method) => { rpcMethod = method; }).catch((error: unknown) => {
                            inputError = error instanceof McpHttpInputError ? "invalid_input" : "internal_error";
                            if (response.destroyed) return;
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
            rollbackRoutes(error, [releaseAll]);
        }
        return releaseAll;
    }

    async #dispatch(
        binding: McpEndpointBinding,
        request: IncomingMessage,
        response: ServerResponse,
        recordMethod: (method: string) => void,
    ): Promise<void> {
        const body = await readJsonBody(request);
        recordMethod(traceField(body !== null && typeof body === "object" && !Array.isArray(body) ? body.method : undefined));
        await binding.handleRequest(request, response, body);
    }
}

function releaseRoutes(releases: readonly (() => void)[]): void {
    const errors: unknown[] = [];
    for (const release of [...releases].reverse()) {
        try { release(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Failed to release MCP Protocol routes.");
}

function rollbackRoutes(error: unknown, releases: readonly (() => void)[]): never {
    try { releaseRoutes(releases); }
    catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "MCP Protocol mount and rollback failed.");
    }
    throw error;
}

function traceField(value: unknown): string {
    const input = Array.isArray(value) ? value[0] : value;
    return typeof input === "string" && /^[a-zA-Z0-9_./-]{1,96}$/u.test(input) ? input : "unknown";
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
