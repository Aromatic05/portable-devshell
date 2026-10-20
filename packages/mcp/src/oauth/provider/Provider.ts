import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
    checkResourceAllowed,
    OAuthError,
    OAuthErrorCode,
    resourceUrlFromServerUrl,
} from "@modelcontextprotocol/server";
import type { OAuthProtectedResourceMetadata } from "@modelcontextprotocol/server";
import {
    getOAuthProtectedResourceMetadataUrl,
    requireBearerAuth,
} from "@modelcontextprotocol/express";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/express";
import type { Request, RequestHandler, Response } from "express";
import { exportJWK, generateKeyPair } from "jose";
import Provider from "oidc-provider";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const ID_TOKEN_TTL_SECONDS = 60 * 60;
const INTERACTION_TTL_SECONDS = 10 * 60;
const LONG_LIVED_TTL_SECONDS = 90 * 24 * 60 * 60;
const REVOCATION_POLL_INTERVAL_MS = 1_000;

import type { McpOAuth2Config } from "../Config.js";
import { McpOAuthApprovalService } from "../interaction/Approval.js";
import { createMcpOAuthOidcAdapterFactory } from "./Adapter.js";
import { fetchPublicOAuthDocument } from "./SafeFetch.js";
import {
    createMcpOAuthStorageSecurity,
    isMcpOAuthStorageMissing,
    type McpOAuthStorageSecurity,
} from "../Storage.js";

export interface McpOAuthProviderRuntimeOptions {
    accountId?: string;
    approvals: McpOAuthApprovalService;
    config: McpOAuth2Config;
    /**
     * Test-only seam for the OIDC provider's outbound fetch. Production uses
     * fetchPublicOAuthDocument, which validates and pins DNS before connect.
     */
    fetch?: typeof globalThis.fetch;
    publicBaseUrl: string;
    storageDir: string;
    storageSecurity?: McpOAuthStorageSecurity;
    trustProxy?: boolean;
}

export interface McpOAuthAccessTokenVerification {
    clientId: string;
    expiresAt: number;
    grantId: string;
    scopes: string[];
}

export interface McpOAuthAccessRevocation {
    grantId: string;
}

export class McpOAuthProviderRuntime {
    readonly #accountId: string;
    readonly #approvals: McpOAuthApprovalService;
    readonly #basePath: string;
    readonly #config: McpOAuth2Config;
    readonly #fetch?: typeof globalThis.fetch;
    readonly #issuerUrl: URL;
    // Each Resource URI can be leased by multiple overlapping MCP Host generations.
    // The latest active registration supplies its configuration.
    readonly #registeredResources = new Map<string, Array<{ config: McpOAuth2Config }>>();
    readonly #revocationListeners = new Set<
        (revocation: McpOAuthAccessRevocation) => void
    >();
    readonly #storageDir: string;
    readonly #storageSecurity: McpOAuthStorageSecurity;
    readonly #trustProxy: boolean;
    #provider?: Provider;
    #refreshProvider?: () => void;
    #observeRevocations?: () => void;
    #revocationTimer?: ReturnType<typeof setInterval>;
    readonly #supportedScopes = new Set<string>();

    constructor(options: McpOAuthProviderRuntimeOptions) {
        this.#accountId = options.accountId ?? readLocalAccountId();
        this.#approvals = options.approvals;
        this.#config = options.config;
        this.#issuerUrl = new URL(options.publicBaseUrl);
        this.#basePath = normalizeBasePath(this.#issuerUrl.pathname);
        this.#fetch = options.fetch;
        this.#storageDir = options.storageDir;
        this.#storageSecurity =
            options.storageSecurity ?? createMcpOAuthStorageSecurity();
        this.#trustProxy = options.trustProxy ?? false;
    }

    get accountId(): string {
        return this.#accountId;
    }

    get basePath(): string {
        return this.#basePath;
    }

    get issuerUrl(): URL {
        return new URL(this.#issuerUrl.href);
    }

    get provider(): Provider {
        if (this.#provider === undefined) {
            throw new Error(
                "OIDC provider is not initialized. Call warmup() before use.",
            );
        }
        return this.#provider;
    }

    get registeredResources(): string[] {
        return [...this.#registeredResources.keys()];
    }

    onAccessRevoked(
        listener: (revocation: McpOAuthAccessRevocation) => void,
    ): () => void {
        this.#revocationListeners.add(listener);
        if (this.#revocationTimer === undefined) {
            this.#revocationTimer = setInterval(() => this.#checkRevocations(), REVOCATION_POLL_INTERVAL_MS);
            this.#revocationTimer.unref?.();
        }
        return () => {
            this.#revocationListeners.delete(listener);
            if (this.#revocationListeners.size === 0) {
                clearInterval(this.#revocationTimer);
                this.#revocationTimer = undefined;
            }
        };
    }

    registerResource(resourceServerUrl: URL, config: McpOAuth2Config): () => void {
        const uri = resourceUrlFromServerUrl(resourceServerUrl).href;
        const registrations = this.#registeredResources.get(uri) ?? [];
        const registration = { config };
        registrations.push(registration);
        this.#registeredResources.set(uri, registrations);
        if (this.#provider !== undefined && config.requiredScopes.some((scope) => !this.#supportedScopes.has(scope))) {
            try { this.#refreshProvider?.(); }
            catch (error) {
                registrations.pop();
                if (registrations.length === 0) this.#registeredResources.delete(uri);
                throw error;
            }
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const index = registrations.indexOf(registration);
            if (index !== -1) registrations.splice(index, 1);
            if (registrations.length === 0) this.#registeredResources.delete(uri);
        };
    }

    /**
     * Control Web is an embedded first-party PKCE client. Store it directly in
     * the owning OIDC adapter, without reopening public client registration.
     */
    async registerFirstPartyWebClient(
        redirectUri: string,
        requiredScopes: readonly string[],
    ): Promise<string> {
        const redirect = new URL(redirectUri);
        if (redirect.origin !== this.#issuerUrl.origin || redirect.username || redirect.password) {
            throw new Error("Control Web OAuth redirect must share the provider origin.");
        }
        await this.warmup();
        const scope = [...new Set(["openid", "offline_access", ...requiredScopes])].join(" ");
        const clientId = `devshell-web-${createHash("sha256")
            .update(JSON.stringify([this.#issuerUrl.href, redirect.href, scope]))
            .digest("hex")}`;
        const metadata = {
            client_id: clientId,
            client_name: "Portable Devshell Control Web",
            grant_types: ["authorization_code", "refresh_token"] as const,
            redirect_uris: [redirect.href],
            response_types: ["code"] as const,
            scope,
            token_endpoint_auth_method: "none" as const,
        };
        const adapter = createMcpOAuthOidcAdapterFactory(
            join(this.#storageDir, "adapter"),
            async (path) => await this.#storageSecurity.secureStorage(path),
            async (path) => await this.#storageSecurity.secureFile(path),
        )("Client");
        const previous = await adapter.find(clientId);
        if (previous !== undefined) {
            if (JSON.stringify(previous.redirect_uris) !== JSON.stringify(metadata.redirect_uris)
                || previous.scope !== metadata.scope
                || previous.token_endpoint_auth_method !== metadata.token_endpoint_auth_method) {
                throw new Error("Persisted first-party Web OAuth client metadata mismatch.");
            }
            return clientId;
        }
        await this.provider.Client.validate(metadata);
        await adapter.upsert(clientId, metadata);
        return clientId;
    }

    #resourceConfigs(): McpOAuth2Config[] {
        return [...this.#registeredResources.values()].map(
            (registrations) => registrations[registrations.length - 1]!.config,
        );
    }

    async warmup(): Promise<void> {
        if (this.#provider !== undefined) {
            return;
        }

        await mkdir(this.#storageDir, { mode: 0o700, recursive: true });
        if (process.platform !== "win32") {
            await chmod(this.#storageDir, 0o700);
        }
        await this.#storageSecurity.secureStorage(this.#storageDir);
        await this.#approvals.warmup();
        const jwks = await readOrCreateJwks(this.#storageDir);
        await this.#storageSecurity.secureStorage(this.#storageDir);
        const adapter = createMcpOAuthOidcAdapterFactory(
            join(this.#storageDir, "adapter"),
            async (path) => await this.#storageSecurity.secureStorage(path),
            async (path) => await this.#storageSecurity.secureFile(path),
        );
        await adapter.prepare();
        let revocationSequence = 0;
        this.#observeRevocations = () => {
            for (const revocation of adapter.revocationsSince(revocationSequence)) {
                // Fences are append-only, so the SQLite rowid is a durable
                // cursor. Advance only after a successful committed read.
                revocationSequence = revocation.sequence;
                this.#notifyAccessRevoked({ grantId: revocation.grantId });
            }
        };
        const buildProvider = () => {
            const provider = new Provider(
                stripTrailingSlash(this.#issuerUrl.href),
                {
                    adapter,
                    clientDefaults: {
                        grant_types: ["authorization_code", "refresh_token"],
                        response_types: ["code"],
                        token_endpoint_auth_method: "none",
                    },
                    claims: {
                        openid: ["sub"],
                    },
                    features: {
                        clientIdMetadataDocument: {
                            ack: "draft-02",
                            allowFetch: async (_ctx, clientId) =>
                                new URL(clientId).search.length === 0,
                            enabled: true,
                        },
                        devInteractions: { enabled: false },
                        resourceIndicators: {
                            defaultResource: async (_ctx, _client, oneOf) => {
                                if (Array.isArray(oneOf) && oneOf.length === 1) {
                                    return oneOf[0];
                                }
                                if (this.#registeredResources.size === 1) {
                                    return [...this.#registeredResources.keys()][0];
                                }
                                throw new Error(
                                    "Unable to determine a default resource indicator.",
                                );
                            },
                            enabled: true,
                            getResourceServerInfo: async (
                                _ctx,
                                resourceIndicator,
                            ) => {
                                const resourceConfig = this.#registeredResources.get(
                                    resourceIndicator,
                                )?.at(-1)?.config;
                                if (resourceConfig === undefined) {
                                    throw new Error(
                                        `Unknown resource indicator: ${resourceIndicator}`,
                                    );
                                }
                                return {
                                    accessTokenFormat: "opaque" as const,
                                    audience: resourceIndicator,
                                    scope: resourceConfig.requiredScopes.join(" "),
                                };
                            },
                            useGrantedResource: async () => true,
                        },
                        revocation: {
                            allowedPolicy: async (_ctx, client, token) =>
                                token.clientId === client.clientId,
                            enabled: true,
                        },
                    },
                    findAccount: async (_ctx, sub) => {
                        if (sub !== this.#accountId) {
                            return undefined;
                        }
                        return {
                            accountId: this.#accountId,
                            claims: async () => ({ sub: this.#accountId }),
                        };
                    },
                    interactions: {
                        url: async (_ctx, interaction) => {
                            return `${this.#basePath}/interaction/${interaction.uid}`;
                        },
                    },
                    jwks,
                    // This issuer revokes the complete grant family, including
                    // access-token revocation through the OIDC endpoint.
                    revokeGrantPolicy: () => true,
                    rotateRefreshToken: true,
                    routes: {
                        authorization: "/authorize",
                        end_session: "/session/end",
                        jwks: "/jwks",
                        revocation: "/revoke",
                        token: "/token",
                        userinfo: "/userinfo",
                    },
                    scopes: [
                        "openid",
                        "offline_access",
                        ...new Set([
                            ...this.#supportedScopes,
                            ...this.#config.requiredScopes,
                            ...this.#resourceConfigs().flatMap(
                                (resource) => resource.requiredScopes,
                            ),
                        ]),
                    ],
                    ttl: {
                        AccessToken: () => ACCESS_TOKEN_TTL_SECONDS,
                        Grant: () => LONG_LIVED_TTL_SECONDS,
                        IdToken: () => ID_TOKEN_TTL_SECONDS,
                        Interaction: () => INTERACTION_TTL_SECONDS,
                        RefreshToken: () => LONG_LIVED_TTL_SECONDS,
                        Session: () => LONG_LIVED_TTL_SECONDS,
                    },
                    fetch: this.#fetch ?? fetchPublicOAuthDocument,
                },
            );
            provider.proxy = this.#trustProxy;
            provider.use(async (ctx, next) => {
                if (ctx.method === "POST" && /^\/(?:token|revoke)\/?$/iu.test(ctx.path)) {
                    await adapter.transaction(next, () => ctx.status);
                } else await next();
            });
            provider.on("access_token.destroyed", (token) => {
                if (typeof token.grantId === "string") {
                    const grantId = token.grantId;
                    adapter.afterCommit(() => this.#notifyAccessRevoked({ grantId }));
                }
            });
            provider.on("grant.revoked", (_context, grantId) => {
                if (typeof grantId === "string") {
                    adapter.afterCommit(() => this.#checkRevocations());
                }
            });
            this.#provider = provider;
            for (const scope of ["openid", "offline_access", ...this.#config.requiredScopes,
                ...this.#resourceConfigs().flatMap((resource) => resource.requiredScopes)])
                this.#supportedScopes.add(scope);
        };
        this.#refreshProvider = buildProvider;
        buildProvider();
    }

    shouldHandleProviderPath(pathname: string): boolean {
        // Resource metadata belongs to Protocol Route, including a newer Host
        // generation that can share this Provider's HTTP listener.
        if (pathname === "/.well-known/oauth-protected-resource" ||
            pathname.startsWith("/.well-known/oauth-protected-resource/")) return false;
        if (pathname.startsWith("/.well-known/")) {
            return true;
        }
        const authPrefixes = [
            "/authorize",
            "/jwks",
            "/revoke",
            "/session",
            "/token",
            "/userinfo",
        ];
        return authPrefixes.some((prefix) => {
            return pathname.startsWith(`${this.#basePath}${prefix}`);
        });
    }

    protectedResourceMetadata(
        resourceServerUrl: URL,
        config: McpOAuth2Config = this.#config,
    ): OAuthProtectedResourceMetadata {
        return {
            authorization_servers: [stripTrailingSlash(this.#issuerUrl.href)],
            resource: resourceUrlFromServerUrl(resourceServerUrl).href,
            resource_documentation: config.documentationUrl,
            resource_name: config.resourceName,
            scopes_supported:
                config.requiredScopes.length === 0
                    ? undefined
                    : [...config.requiredScopes],
        };
    }

    protectedResourceMetadataHandler(
        resourceServerUrl: URL,
        config: McpOAuth2Config = this.#config,
    ): RequestHandler {
        return async (_request: Request, response: Response) => {
            response.json(
                this.protectedResourceMetadata(resourceServerUrl, config),
            );
        };
    }

    requestAuthHandler(
        resourceServerUrl: URL,
        config: McpOAuth2Config = this.#config,
    ): RequestHandler {
        return requireBearerAuth({
            requiredScopes: config.requiredScopes,
            resourceMetadataUrl:
                getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
            verifier: new McpOAuthResourceVerifier(
                this.provider,
                resourceServerUrl,
                config.requiredScopes,
            ),
        });
    }

    async verifyAccessToken(
        resourceServerUrl: URL,
        token: string,
    ): Promise<McpOAuthAccessTokenVerification> {
        const config =
            this.#registeredResources.get(
                resourceUrlFromServerUrl(resourceServerUrl).href,
            )?.at(-1)?.config ?? this.#config;
        const verified = await new McpOAuthResourceVerifier(
            this.provider,
            resourceServerUrl,
            config.requiredScopes,
        ).verifyAccessToken(token);
        return {
            clientId: verified.clientId,
            expiresAt: verified.expiresAt,
            grantId: verified.grantId,
            scopes: [...verified.scopes],
        };
    }

    #checkRevocations(): void {
        try { this.#observeRevocations?.(); }
        catch (error) {
            // A transient read failure must neither close healthy sockets nor
            // fail an OAuth operation. Leave the cursor for the next poll.
            console.warn(error instanceof Error ? error : new Error(String(error)));
        }
    }

    #notifyAccessRevoked(revocation: McpOAuthAccessRevocation): void {
        for (const listener of [...this.#revocationListeners]) {
            try {
                listener(revocation);
            } catch (error) {
                console.warn(
                    error instanceof Error ? error : new Error(String(error)),
                );
            }
        }
    }
}

class McpOAuthResourceVerifier implements OAuthTokenVerifier {
    readonly #expectedResourceUrl: URL;
    readonly #provider: Provider;
    readonly #requiredScopes: readonly string[];

    constructor(
        provider: Provider,
        expectedResourceUrl: URL,
        requiredScopes: readonly string[],
    ) {
        this.#provider = provider;
        this.#expectedResourceUrl =
            resourceUrlFromServerUrl(expectedResourceUrl);
        this.#requiredScopes = requiredScopes;
    }

    async verifyAccessToken(token: string) {
        const accessToken = await this.#provider.AccessToken.find(token);
        if (accessToken === undefined || accessToken.isValid !== true) {
            throw new OAuthError(
                OAuthErrorCode.InvalidToken,
                "Token is invalid or expired.",
            );
        }

        const resources = readTokenResources(accessToken.aud);
        if (resources === undefined) {
            throw new OAuthError(
                OAuthErrorCode.InvalidToken,
                "Token resource audience is missing or invalid.",
            );
        }
        const resource = resources.find((candidate) =>
            checkResourceAllowed({
                configuredResource: this.#expectedResourceUrl,
                requestedResource: candidate,
            }),
        );
        if (resource === undefined) {
            throw new OAuthError(
                OAuthErrorCode.InvalidToken,
                `Token resource audience is not valid for ${this.#expectedResourceUrl.href}.`,
            );
        }

        const grantedScopes = new Set(accessToken.scopes);
        const missingScope = this.#requiredScopes.find(
            (scope) => !grantedScopes.has(scope),
        );
        if (missingScope !== undefined) {
            throw new OAuthError(
                OAuthErrorCode.InvalidToken,
                `Token is missing required resource scope: ${missingScope}.`,
            );
        }

        if (
            typeof accessToken.clientId !== "string" ||
            accessToken.clientId.length === 0
        ) {
            throw new OAuthError(
                OAuthErrorCode.ServerError,
                "Issued access token does not include a client identifier.",
            );
        }
        if (typeof accessToken.exp !== "number") {
            throw new OAuthError(
                OAuthErrorCode.ServerError,
                "Issued access token does not include an expiration.",
            );
        }
        if (
            typeof accessToken.grantId !== "string" ||
            accessToken.grantId.length === 0
        ) {
            throw new OAuthError(
                OAuthErrorCode.ServerError,
                "Issued access token does not include a grant identifier.",
            );
        }

        return {
            clientId: accessToken.clientId,
            expiresAt: accessToken.exp,
            grantId: accessToken.grantId,
            extra: {
                subject:
                    typeof (accessToken as { accountId?: unknown })
                        .accountId === "string"
                        ? (accessToken as { accountId: string }).accountId
                        : accessToken.clientId,
            },
            resource,
            scopes: [...accessToken.scopes],
            token,
        };
    }
}

function normalizeBasePath(pathname: string): string {
    if (pathname === "/") {
        return "";
    }
    return pathname.replace(/\/+$/u, "");
}

function stripTrailingSlash(value: string): string {
    return value.endsWith("/") ? value.slice(0, -1) : value;
}

function readLocalAccountId(): string {
    try {
        return userInfo().username;
    } catch {
        return "aromatic";
    }
}

function readTokenResources(
    audience: string | string[] | undefined,
): URL[] | undefined {
    const values =
        typeof audience === "string"
            ? [audience]
            : Array.isArray(audience)
              ? audience
              : [];
    if (values.length === 0) {
        return undefined;
    }
    const resources: URL[] = [];
    for (const value of values) {
        try {
            resources.push(new URL(value));
        } catch {
            return undefined;
        }
    }
    return resources;
}

async function readOrCreateJwks(
    storageDir: string,
): Promise<{ keys: Array<Record<string, unknown>> }> {
    const jwksPath = join(storageDir, "jwks.json");
    const readJwks = async () => {
        const jwks = JSON.parse(await readFile(jwksPath, "utf8")) as {
            keys: Array<Record<string, unknown>>;
        };
        if (process.platform !== "win32") {
            await chmod(jwksPath, 0o600);
            // A concurrent publisher may not have synced the new directory entry
            // yet. Every reader makes it durable before using the signing key.
            const directory = await open(storageDir, "r");
            try {
                await directory.sync();
            } finally {
                await directory.close();
            }
        }
        return jwks;
    };
    try {
        return await readJwks();
    } catch (error) {
        if (!isMcpOAuthStorageMissing(error)) {
            throw error;
        }
    }

    const { privateKey } = await generateKeyPair("RS256", {
        extractable: true,
    });
    const jwk = await exportJWK(privateKey);
    jwk.alg = "RS256";
    jwk.kid = "aromatic-oidc-signing-key";
    jwk.use = "sig";
    const jwks = {
        keys: [jwk as unknown as Record<string, unknown>],
    };
    const temporary = `${jwksPath}.${process.pid}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
        try {
            await file.writeFile(JSON.stringify(jwks), "utf8");
            await file.sync();
        } finally {
            await file.close();
        }
        try {
            // Same-filesystem hard links publish the complete, synced private
            // file atomically and never replace another starter's winning key.
            await link(temporary, jwksPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }
        }
    } finally {
        // A throw from removing an obsolete temporary file cannot invalidate
        // an already published, complete signing key.
        await rm(temporary, { force: true }).catch((error: unknown) => {
            console.warn("OAuth JWKS temporary cleanup deferred:", error);
        });
    }
    return await readJwks();
}
