import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { HttpHost, McpOAuthProtectedResource } from "@portable-devshell/mcp";
import type { ControlWebOAuth2Config } from "@portable-devshell/shared";

import type { ControlWebSessionService } from "./ControlWebSessionService.js";

const STATE_COOKIE_NAME = "devshell_web_oauth_state";
const STATE_TTL_MS = 10 * 60 * 1_000;
const STATE_TTL_SECONDS = Math.floor(STATE_TTL_MS / 1_000);

export interface ControlWebOAuthFlowOptions {
    basePath: string;
    config: ControlWebOAuth2Config;
    installProvider?: boolean;
    now?: () => number;
    ownsProvider: boolean;
    protectedResource: McpOAuthProtectedResource;
    publicBaseUrl: string;
    secureCookie?: boolean;
    sessions: ControlWebSessionService;
}

interface OAuthEndpoints {
    authorizationEndpoint: string;
    registrationEndpoint: string;
    tokenEndpoint: string;
}

interface PendingAuthorization {
    createdAt: number;
    verifier: string;
}

export class ControlWebOAuthFlow {
    readonly #basePath: string;
    readonly #config: ControlWebOAuth2Config;
    readonly #installProvider: boolean;
    readonly #now: () => number;
    readonly #ownsProvider: boolean;
    readonly #pending = new Map<string, PendingAuthorization>();
    readonly #protectedResource: McpOAuthProtectedResource;
    readonly #resourceUrl: URL;
    readonly #secureCookie: boolean;
    readonly #sessions: ControlWebSessionService;
    #clientId?: string;
    #endpoints?: OAuthEndpoints;

    constructor(options: ControlWebOAuthFlowOptions) {
        this.#basePath = normalizeBasePath(options.basePath);
        this.#config = options.config;
        this.#installProvider = options.installProvider ?? options.ownsProvider;
        this.#now = options.now ?? Date.now;
        this.#ownsProvider = options.ownsProvider;
        this.#protectedResource = options.protectedResource;
        const publicUrl = new URL(options.publicBaseUrl);
        this.#resourceUrl = new URL(this.#basePath, `${publicUrl.origin}/`);
        this.#secureCookie = options.secureCookie ?? false;
        this.#sessions = options.sessions;
    }

    get resourceUrl(): URL {
        return new URL(this.#resourceUrl.href);
    }

    async warmup(): Promise<void> {
        if (this.#ownsProvider) {
            await this.#protectedResource.warmup();
        }
        this.#protectedResource.registerResource(this.resourceUrl, this.#providerConfig());
    }

    install(http: HttpHost): () => void {
        const metadataPath = `/.well-known/oauth-protected-resource${this.#basePath}`;
        const removeMetadata = http.registerRawRoute("get", metadataPath, (_request, response) => {
            writeJson(response, 200, this.#protectedResource.protectedResourceMetadata(this.resourceUrl, this.#providerConfig()));
        });
        const removeStart = http.registerRawRoute("get", `${this.#basePath}/oauth/start`, (request, response) => {
            void this.#start(request, response).catch(() => writeJson(response, 500, { error: "OAuth start failed" }));
        });
        const removeCallback = http.registerRawRoute("get", `${this.#basePath}/oauth/callback`, (request, response) => {
            void this.#callback(request, response).catch(() => writeJson(response, 500, { error: "OAuth callback failed" }));
        });
        if (this.#installProvider) {
            http.installOAuth(this.#protectedResource);
        }
        return () => {
            removeMetadata();
            removeStart();
            removeCallback();
        };
    }

    async #start(_request: IncomingMessage, response: ServerResponse): Promise<void> {
        const endpoints = await this.#discover();
        const clientId = await this.#ensureClient(endpoints);
        const state = randomBytes(24).toString("base64url");
        const verifier = randomBytes(32).toString("base64url");
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        this.#prunePending();
        this.#pending.set(state, { createdAt: this.#now(), verifier });

        const authorizationUrl = new URL(endpoints.authorizationEndpoint);
        authorizationUrl.searchParams.set("client_id", clientId);
        authorizationUrl.searchParams.set("code_challenge", challenge);
        authorizationUrl.searchParams.set("code_challenge_method", "S256");
        authorizationUrl.searchParams.set("redirect_uri", this.#redirectUri);
        authorizationUrl.searchParams.set("resource", this.resourceUrl.href);
        authorizationUrl.searchParams.set("response_type", "code");
        authorizationUrl.searchParams.set("scope", this.#scope());
        authorizationUrl.searchParams.set("state", state);

        response.setHeader("Set-Cookie", this.#stateCookie(state, STATE_TTL_SECONDS));
        response.statusCode = 302;
        response.setHeader("Location", authorizationUrl.href);
        response.setHeader("Cache-Control", "no-store");
        response.end();
    }

    async #callback(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
        const code = requestUrl.searchParams.get("code");
        const state = requestUrl.searchParams.get("state");
        const stateCookie = readCookie(request.headers.cookie, STATE_COOKIE_NAME);
        const pending = state === null ? undefined : this.#pending.get(state);
        if (code === null || state === null || stateCookie !== state || pending === undefined) {
            writeJson(response, 400, { error: "OAuth state validation failed" });
            return;
        }
        this.#pending.delete(state);

        const endpoints = await this.#discover();
        const tokenResponse = await fetch(endpoints.tokenEndpoint, {
            body: new URLSearchParams({
                client_id: await this.#ensureClient(endpoints),
                code,
                code_verifier: pending.verifier,
                grant_type: "authorization_code",
                redirect_uri: this.#redirectUri
            }),
            headers: { "content-type": "application/x-www-form-urlencoded" },
            method: "POST"
        });
        if (!tokenResponse.ok) {
            writeJson(response, 401, { error: "OAuth token exchange failed" });
            return;
        }
        const tokens = (await tokenResponse.json()) as { access_token?: unknown };
        if (typeof tokens.access_token !== "string") {
            writeJson(response, 401, { error: "OAuth token exchange returned no access token" });
            return;
        }
        try {
            await this.#protectedResource.verifyAccessToken(this.resourceUrl, tokens.access_token);
        } catch {
            writeJson(response, 401, { error: "OAuth access token is not valid for this resource" });
            return;
        }

        response.setHeader("Set-Cookie", [
            this.#sessions.createSessionCookie(),
            this.#stateCookie("", 0)
        ]);
        response.statusCode = 302;
        response.setHeader("Location", `${stripTrailingSlash(this.#resourceUrl.href)}/`);
        response.setHeader("Cache-Control", "no-store");
        response.end();
    }

    get #redirectUri(): string {
        return `${stripTrailingSlash(this.#resourceUrl.href)}/oauth/callback`;
    }

    #scope(): string {
        return ["openid", "offline_access", ...this.#config.requiredScopes].join(" ").trim();
    }

    #providerConfig() {
        return {
            documentationUrl: this.#config.documentationUrl,
            requiredScopes: [...this.#config.requiredScopes],
            resourceName: this.#config.resourceName
        };
    }

    async #discover(): Promise<OAuthEndpoints> {
        if (this.#endpoints !== undefined) {
            return this.#endpoints;
        }
        const metadataUrl = new URL("/.well-known/openid-configuration", this.#protectedResource.issuerUrl);
        const metadataResponse = await fetch(metadataUrl);
        if (!metadataResponse.ok) {
            throw new Error("Unable to read OAuth authorization server metadata.");
        }
        const metadata = (await metadataResponse.json()) as {
            authorization_endpoint?: unknown;
            registration_endpoint?: unknown;
            token_endpoint?: unknown;
        };
        if (
            typeof metadata.authorization_endpoint !== "string" ||
            typeof metadata.registration_endpoint !== "string" ||
            typeof metadata.token_endpoint !== "string"
        ) {
            throw new Error("OAuth authorization server metadata is incomplete.");
        }
        this.#endpoints = {
            authorizationEndpoint: metadata.authorization_endpoint,
            registrationEndpoint: metadata.registration_endpoint,
            tokenEndpoint: metadata.token_endpoint
        };
        return this.#endpoints;
    }

    async #ensureClient(endpoints: OAuthEndpoints): Promise<string> {
        if (this.#clientId !== undefined) {
            return this.#clientId;
        }
        const registrationResponse = await fetch(endpoints.registrationEndpoint, {
            body: JSON.stringify({
                grant_types: ["authorization_code", "refresh_token"],
                redirect_uris: [this.#redirectUri],
                response_types: ["code"],
                token_endpoint_auth_method: "none"
            }),
            headers: { "content-type": "application/json" },
            method: "POST"
        });
        if (registrationResponse.status !== 201) {
            throw new Error("Unable to register the Web OAuth client.");
        }
        const client = (await registrationResponse.json()) as { client_id?: unknown };
        if (typeof client.client_id !== "string") {
            throw new Error("OAuth client registration returned no client identifier.");
        }
        this.#clientId = client.client_id;
        return this.#clientId;
    }

    #prunePending(): void {
        const now = this.#now();
        for (const [state, pending] of this.#pending) {
            if (pending.createdAt + STATE_TTL_MS <= now) {
                this.#pending.delete(state);
            }
        }
    }

    #stateCookie(value: string, maxAgeSeconds: number): string {
        return [
            `${STATE_COOKIE_NAME}=${value}`,
            `Path=${this.#basePath}`,
            "HttpOnly",
            "SameSite=Lax",
            `Max-Age=${maxAgeSeconds}`,
            ...(this.#secureCookie ? ["Secure"] : [])
        ].join("; ");
    }
}

function normalizeBasePath(value: string): string {
    if (!value.startsWith("/") || value === "/") {
        throw new Error("Control web basePath must be an absolute non-root path.");
    }
    return value.replace(/\/+$/u, "");
}

function stripTrailingSlash(value: string): string {
    return value.endsWith("/") ? value.slice(0, -1) : value;
}

function readCookie(header: string | undefined, name: string): string | undefined {
    if (header === undefined) {
        return undefined;
    }
    for (const segment of header.split(";")) {
        const separator = segment.indexOf("=");
        if (separator < 0) {
            continue;
        }
        if (segment.slice(0, separator).trim() !== name) {
            continue;
        }
        const value = segment.slice(separator + 1).trim();
        return value.length === 0 ? undefined : value;
    }
    return undefined;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
    if (response.headersSent) {
        response.end();
        return;
    }
    const payload = JSON.stringify(body);
    response.statusCode = statusCode;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Content-Length", Buffer.byteLength(payload));
    response.end(payload);
}
