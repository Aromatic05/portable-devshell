import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";

import {
    InvalidTokenError,
    ServerError
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import {
    checkResourceAllowed,
    resourceUrlFromServerUrl
} from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
    Request,
    RequestHandler,
    Response
} from "express";
import { exportJWK, generateKeyPair } from "jose";
import Provider, {
    errors,
    type Adapter,
    type AdapterFactory,
    type AdapterPayload
} from "oidc-provider";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const ID_TOKEN_TTL_SECONDS = 60 * 60;
const INTERACTION_TTL_SECONDS = 10 * 60;
const LONG_LIVED_TTL_SECONDS = 90 * 24 * 60 * 60;
const DYNAMIC_CLIENT_REQUIRED_SCOPES = ["openid", "offline_access"] as const;

import type { McpOAuth2Config } from "../McpAuthConfig.js";
import {
    McpOAuthApprovalService,
    OAuthApprovalCapacityError,
    type OAuthApprovalInput
} from "./McpOAuthApprovalService.js";
import { createMcpOAuthOidcFileAdapterFactory } from "./McpOAuthOidcFileAdapter.js";
import {
    createMcpOAuthStorageSecurity,
    type McpOAuthStorageSecurity
} from "./McpOAuthStorageSecurity.js";

export interface McpOAuthProviderRuntimeOptions {
    accountId?: string;
    approvals: McpOAuthApprovalService;
    config: McpOAuth2Config;
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
    readonly #issuerUrl: URL;
    readonly #registeredResources = new Map<string, McpOAuth2Config>();
    readonly #revocationListeners = new Set<(revocation: McpOAuthAccessRevocation) => void>();
    readonly #storageDir: string;
    readonly #storageSecurity: McpOAuthStorageSecurity;
    readonly #trustProxy: boolean;
    #provider?: Provider;

    constructor(options: McpOAuthProviderRuntimeOptions) {
        this.#accountId = options.accountId ?? readLocalAccountId();
        this.#approvals = options.approvals;
        this.#config = options.config;
        this.#issuerUrl = new URL(options.publicBaseUrl);
        this.#basePath = normalizeBasePath(this.#issuerUrl.pathname);
        this.#storageDir = options.storageDir;
        this.#storageSecurity = options.storageSecurity ?? createMcpOAuthStorageSecurity();
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
                "OIDC provider is not initialized. Call warmup() before use."
            );
        }
        return this.#provider;
    }

    get registeredResources(): string[] {
        return [...this.#registeredResources.keys()];
    }

    onAccessRevoked(listener: (revocation: McpOAuthAccessRevocation) => void): () => void {
        this.#revocationListeners.add(listener);
        return () => this.#revocationListeners.delete(listener);
    }

    registerResource(resourceServerUrl: URL, config: McpOAuth2Config): void {
        this.#registeredResources.set(
            resourceUrlFromServerUrl(resourceServerUrl).href,
            config
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
        const dynamicClientRequiredScopes = () => [
            ...new Set([
                ...DYNAMIC_CLIENT_REQUIRED_SCOPES,
                ...this.#config.requiredScopes,
                ...[...this.#registeredResources.values()].flatMap(
                    (resource) => resource.requiredScopes
                )
            ])
        ];
        const provider = new Provider(stripTrailingSlash(this.#issuerUrl.href), {
            adapter: createDynamicClientScopeAdapterFactory(
                createMcpOAuthOidcFileAdapterFactory(
                    join(this.#storageDir, "adapter"),
                    async (path) => await this.#storageSecurity.secureStorage(path),
                ),
                dynamicClientRequiredScopes,
                async (clientId, payload) => {
                    try {
                        await this.#approvals.registerClient(
                            toRegistrationApprovalInputFromPayload(clientId, payload)
                        );
                    } catch (error) {
                        if (error instanceof OAuthApprovalCapacityError) {
                            throw new errors.InvalidRequest(error.message, 429);
                        }
                        throw error;
                    }
                }
            ),
            clientDefaults: {
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                token_endpoint_auth_method: "none"
            },
            claims: {
                openid: ["sub"]
            },
            features: {
                devInteractions: { enabled: false },
                registration: {
                    enabled: true,
                    initialAccessToken: false
                },
                registrationManagement: {
                    enabled: true
                },
                resourceIndicators: {
                    defaultResource: async (_ctx, _client, oneOf) => {
                        if (Array.isArray(oneOf) && oneOf.length === 1) {
                            return oneOf[0];
                        }
                        if (this.#registeredResources.size === 1) {
                            return [...this.#registeredResources.keys()][0];
                        }
                        throw new Error(
                            "Unable to determine a default resource indicator."
                        );
                    },
                    enabled: true,
                    getResourceServerInfo: async (_ctx, resourceIndicator) => {
                        const resourceConfig = this.#registeredResources.get(resourceIndicator);
                        if (resourceConfig === undefined) {
                            throw new Error(
                                `Unknown resource indicator: ${resourceIndicator}`
                            );
                        }
                        return {
                            accessTokenFormat: "opaque" as const,
                            audience: resourceIndicator,
                            scope: resourceConfig.requiredScopes.join(" ")
                        };
                    },
                    useGrantedResource: async () => true
                },
                revocation: {
                    allowedPolicy: async (_ctx, client, token) => token.clientId === client.clientId,
                    enabled: true
                }
            },
            findAccount: async (_ctx, sub) => {
                if (sub !== this.#accountId) {
                    return undefined;
                }
                return {
                    accountId: this.#accountId,
                    claims: async () => ({ sub: this.#accountId })
                };
            },
            interactions: {
                url: async (_ctx, interaction) => {
                    return `${this.#basePath}/interaction/${interaction.uid}`;
                }
            },
            jwks,
            routes: {
                authorization: "/authorize",
                end_session: "/session/end",
                jwks: "/jwks",
                registration: "/register",
                revocation: "/revoke",
                token: "/token",
                userinfo: "/userinfo"
            },
            scopes: [
                "openid",
                "offline_access",
                ...new Set([
                    ...this.#config.requiredScopes,
                    ...[...this.#registeredResources.values()].flatMap(
                        (resource) => resource.requiredScopes
                    )
                ])
            ],
            ttl: {
                AccessToken: () => ACCESS_TOKEN_TTL_SECONDS,
                Grant: () => LONG_LIVED_TTL_SECONDS,
                IdToken: () => ID_TOKEN_TTL_SECONDS,
                Interaction: () => INTERACTION_TTL_SECONDS,
                RefreshToken: () => LONG_LIVED_TTL_SECONDS,
                Session: () => LONG_LIVED_TTL_SECONDS
            }
        });
        provider.proxy = this.#trustProxy;
        provider.on("registration_create.success", (context, client) => {
            const scope = extendDynamicClientScope(client.scope, dynamicClientRequiredScopes());
            (client as unknown as { scope: string }).scope = scope;
            if (isRecord(context.body)) {
                context.body.scope = scope;
            }
        });
        provider.on("access_token.destroyed", (token) => {
            if (typeof token.grantId === "string") {
                this.#notifyAccessRevoked({ grantId: token.grantId });
            }
        });
        provider.on("grant.revoked", (_context, grantId) => {
            if (typeof grantId === "string") {
                this.#notifyAccessRevoked({ grantId });
            }
        });
        this.#provider = provider;
    }

    shouldHandleProviderPath(pathname: string): boolean {
        if (pathname.startsWith("/.well-known/")) {
            return true;
        }
        const authPrefixes = [
            "/authorize",
            "/jwks",
            "/register",
            "/revoke",
            "/session",
            "/token",
            "/userinfo"
        ];
        return authPrefixes.some((prefix) => {
            return pathname.startsWith(`${this.#basePath}${prefix}`);
        });
    }

    protectedResourceMetadata(
        resourceServerUrl: URL,
        config: McpOAuth2Config = this.#config
    ): OAuthProtectedResourceMetadata {
        return {
            authorization_servers: [stripTrailingSlash(this.#issuerUrl.href)],
            resource: resourceUrlFromServerUrl(resourceServerUrl).href,
            resource_documentation: config.documentationUrl,
            resource_name: config.resourceName,
            scopes_supported: config.requiredScopes.length === 0
                ? undefined
                : [...config.requiredScopes]
        };
    }

    protectedResourceMetadataHandler(
        resourceServerUrl: URL,
        config: McpOAuth2Config = this.#config
    ): RequestHandler {
        return async (_request: Request, response: Response) => {
            response.json(this.protectedResourceMetadata(resourceServerUrl, config));
        };
    }

    requestAuthHandler(resourceServerUrl: URL, config: McpOAuth2Config = this.#config): RequestHandler {
        return requireBearerAuth({
            requiredScopes: config.requiredScopes,
            resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(
                resourceServerUrl
            ),
            verifier: new McpOAuthResourceVerifier(
                this.provider,
                resourceServerUrl,
                config.requiredScopes
            )
        });
    }

    async verifyAccessToken(
        resourceServerUrl: URL,
        token: string
    ): Promise<McpOAuthAccessTokenVerification> {
        const config = this.#registeredResources.get(
            resourceUrlFromServerUrl(resourceServerUrl).href
        ) ?? this.#config;
        const verified = await new McpOAuthResourceVerifier(
            this.provider,
            resourceServerUrl,
            config.requiredScopes
        ).verifyAccessToken(token);
        return {
            clientId: verified.clientId,
            expiresAt: verified.expiresAt,
            grantId: verified.grantId,
            scopes: [...verified.scopes]
        };
    }

    #notifyAccessRevoked(revocation: McpOAuthAccessRevocation): void {
        for (const listener of [...this.#revocationListeners]) {
            try {
                listener(revocation);
            } catch (error) {
                console.warn(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }
}

function createDynamicClientScopeAdapterFactory(
    delegate: AdapterFactory,
    requiredScopes: () => readonly string[],
    onClientCreated: (clientId: string, payload: AdapterPayload) => Promise<void>
): AdapterFactory {
    return (name) => {
        const adapter = delegate(name);
        return name === "Client"
            ? new DynamicClientScopeAdapter(adapter, requiredScopes, onClientCreated)
            : adapter;
    };
}

class DynamicClientScopeAdapter implements Adapter {
    constructor(
        private readonly delegate: Adapter,
        private readonly requiredScopes: () => readonly string[],
        private readonly onClientCreated: (clientId: string, payload: AdapterPayload) => Promise<void>
    ) {}

    async consume(id: string): Promise<void> {
        await this.delegate.consume(id);
    }

    async destroy(id: string): Promise<void> {
        await this.delegate.destroy(id);
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
        const payload = await this.delegate.find(id);
        if (payload === undefined) {
            return undefined;
        }
        const extended = extendDynamicClientPayload(payload, this.requiredScopes());
        if (extended !== payload) {
            await this.delegate.upsert(id, extended, 0);
        }
        return extended;
    }

    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
        return await this.delegate.findByUid(uid) ?? undefined;
    }

    async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
        return await this.delegate.findByUserCode(userCode) ?? undefined;
    }

    async revokeByGrantId(grantId: string): Promise<void> {
        await this.delegate.revokeByGrantId(grantId);
    }

    async upsert(
        id: string,
        payload: AdapterPayload,
        expiresIn: number
    ): Promise<void> {
        const existing = await this.delegate.find(id);
        const extended = extendDynamicClientPayload(payload, this.requiredScopes());
        await this.delegate.upsert(id, extended, expiresIn);
        if (existing !== undefined) return;
        try {
            await this.onClientCreated(id, extended);
        } catch (error) {
            try {
                await this.delegate.destroy(id);
            } catch (rollbackError) {
                throw new AggregateError(
                    [error, rollbackError],
                    `Dynamic client ${id} approval failed and client rollback was incomplete.`
                );
            }
            throw error;
        }
    }
}

function extendDynamicClientPayload(
    payload: AdapterPayload,
    requiredScopes: readonly string[]
): AdapterPayload {
    const scope = extendDynamicClientScope(payload.scope, requiredScopes);
    return scope === payload.scope
        ? payload
        : { ...payload, scope };
}

function extendDynamicClientScope(value: unknown, requiredScopes: readonly string[]): string {
    const scopes = typeof value === "string"
        ? value.split(/\s+/u).filter((scope) => scope.length > 0)
        : [];
    for (const scope of requiredScopes) {
        if (!scopes.includes(scope)) {
            scopes.push(scope);
        }
    }
    return scopes.join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

class McpOAuthResourceVerifier implements OAuthTokenVerifier {
    readonly #expectedResourceUrl: URL;
    readonly #provider: Provider;
    readonly #requiredScopes: readonly string[];

    constructor(
        provider: Provider,
        expectedResourceUrl: URL,
        requiredScopes: readonly string[]
    ) {
        this.#provider = provider;
        this.#expectedResourceUrl = resourceUrlFromServerUrl(
            expectedResourceUrl
        );
        this.#requiredScopes = requiredScopes;
    }

    async verifyAccessToken(token: string) {
        const accessToken = await this.#provider.AccessToken.find(token);
        if (accessToken === undefined || accessToken.isValid !== true) {
            throw new InvalidTokenError("Token is invalid or expired.");
        }

        const resources = readTokenResources(accessToken.aud);
        if (resources === undefined) {
            throw new InvalidTokenError("Token resource audience is missing or invalid.");
        }
        const resource = resources.find((candidate) =>
            checkResourceAllowed({
                configuredResource: this.#expectedResourceUrl,
                requestedResource: candidate
            })
        );
        if (resource === undefined) {
            throw new InvalidTokenError(
                `Token resource audience is not valid for ${this.#expectedResourceUrl.href}.`
            );
        }

        const grantedScopes = new Set(accessToken.scopes);
        const missingScope = this.#requiredScopes.find(
            (scope) => !grantedScopes.has(scope)
        );
        if (missingScope !== undefined) {
            throw new InvalidTokenError(
                `Token is missing required resource scope: ${missingScope}.`
            );
        }

        if (
            typeof accessToken.clientId !== "string" ||
            accessToken.clientId.length === 0
        ) {
            throw new ServerError(
                "Issued access token does not include a client identifier."
            );
        }
        if (typeof accessToken.exp !== "number") {
            throw new ServerError(
                "Issued access token does not include an expiration."
            );
        }
        if (
            typeof accessToken.grantId !== "string" ||
            accessToken.grantId.length === 0
        ) {
            throw new ServerError(
                "Issued access token does not include a grant identifier."
            );
        }

        return {
            clientId: accessToken.clientId,
            expiresAt: accessToken.exp,
            grantId: accessToken.grantId,
            extra: {
                subject: typeof (accessToken as { accountId?: unknown }).accountId ===
                    "string"
                    ? (accessToken as { accountId: string }).accountId
                    : accessToken.clientId
            },
            resource,
            scopes: [...accessToken.scopes],
            token
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
    audience: string | string[] | undefined
): URL[] | undefined {
    const values = typeof audience === "string"
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

function toRegistrationApprovalInputFromPayload(clientId: string, payload: AdapterPayload): OAuthApprovalInput {
    return {
        clientId,
        clientName: readClientName(clientId, payload.client_name),
        redirectUris: readStringArray(payload.redirect_uris)
    };
}

function readClientName(clientId: unknown, clientName: unknown): string {
    if (typeof clientName === "string" && clientName.length > 0) {
        return clientName;
    }
    if (typeof clientId === "string" && clientId.length > 0) {
        return clientId;
    }
    return "unknown-client";
}

function readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry): entry is string => {
        return typeof entry === "string";
    });
}

async function readOrCreateJwks(
    storageDir: string
): Promise<{ keys: Array<Record<string, unknown>> }> {
    const jwksPath = join(storageDir, "jwks.json");
    try {
        const jwks = JSON.parse(await readFile(jwksPath, "utf8")) as {
            keys: Array<Record<string, unknown>>;
        };
        if (process.platform !== "win32") {
            await chmod(jwksPath, 0o600);
        }
        return jwks;
    } catch (error) {
        if (!isMissing(error)) {
            throw error;
        }
    }

    const { privateKey } = await generateKeyPair("RS256", {
        extractable: true
    });
    const jwk = await exportJWK(privateKey);
    jwk.alg = "RS256";
    jwk.kid = "aromatic-oidc-signing-key";
    jwk.use = "sig";
    const jwks = {
        keys: [jwk as unknown as Record<string, unknown>]
    };
    const temporary = `${jwksPath}.${process.pid}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
        await file.writeFile(JSON.stringify(jwks), "utf8");
        await file.sync();
    } catch (error) {
        await file.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
    await file.close();
    try {
        await rename(temporary, jwksPath);
        if (process.platform !== "win32") {
            await chmod(jwksPath, 0o600);
            const directory = await open(storageDir, "r");
            try {
                await directory.sync();
            } finally {
                await directory.close();
            }
        }
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
    return jwks;
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT";
}
