import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import Provider from "oidc-provider";

import type { McpOAuth2Config } from "../McpAuthConfig.js";
import {
    McpOAuthApprovalService,
    type OAuthApprovalInput
} from "./McpOAuthApprovalService.js";
import { createMcpOAuthOidcFileAdapterFactory } from "./McpOAuthOidcFileAdapter.js";

export interface McpOAuthProviderRuntimeOptions {
    accountId?: string;
    approvals: McpOAuthApprovalService;
    config: McpOAuth2Config;
    publicBaseUrl: string;
    storageDir: string;
    trustProxy?: boolean;
}

export class McpOAuthProviderRuntime {
    readonly #accountId: string;
    readonly #approvals: McpOAuthApprovalService;
    readonly #basePath: string;
    readonly #config: McpOAuth2Config;
    readonly #issuerUrl: URL;
    readonly #registeredResources = new Set<string>();
    readonly #storageDir: string;
    readonly #trustProxy: boolean;
    #provider?: Provider;

    constructor(options: McpOAuthProviderRuntimeOptions) {
        this.#accountId = options.accountId ?? readLocalAccountId();
        this.#approvals = options.approvals;
        this.#config = options.config;
        this.#issuerUrl = new URL(options.publicBaseUrl);
        this.#basePath = normalizeBasePath(this.#issuerUrl.pathname);
        this.#storageDir = options.storageDir;
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
        return [...this.#registeredResources];
    }

    registerResource(resourceServerUrl: URL): void {
        this.#registeredResources.add(
            resourceUrlFromServerUrl(resourceServerUrl).href
        );
    }

    async warmup(): Promise<void> {
        if (this.#provider !== undefined) {
            return;
        }

        await mkdir(this.#storageDir, { recursive: true });
        await this.#approvals.warmup();
        const jwks = await readOrCreateJwks(this.#storageDir);
        const provider = new Provider(stripTrailingSlash(this.#issuerUrl.href), {
            adapter: createMcpOAuthOidcFileAdapterFactory(
                join(this.#storageDir, "adapter")
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
                            return [...this.#registeredResources][0];
                        }
                        throw new Error(
                            "Unable to determine a default resource indicator."
                        );
                    },
                    enabled: true,
                    getResourceServerInfo: async (_ctx, resourceIndicator) => {
                        if (!this.#registeredResources.has(resourceIndicator)) {
                            throw new Error(
                                `Unknown resource indicator: ${resourceIndicator}`
                            );
                        }
                        return {
                            accessTokenFormat: "opaque" as const,
                            audience: resourceIndicator,
                            scope: this.#config.requiredScopes.join(" ")
                        };
                    },
                    useGrantedResource: async () => true
                },
                revocation: {
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
                ...this.#config.requiredScopes
            ],
            ttl: {
                AccessToken: () => 24 * 60 * 60,
                Grant: () => 30 * 24 * 60 * 60,
                IdToken: () => 60 * 60,
                Interaction: () => 10 * 60,
                Session: () => 30 * 24 * 60 * 60
            }
        });
        provider.proxy = this.#trustProxy;
        provider.on("registration_create.success", (_context, client) => {
            void this.#approvals.registerClient(
                toRegistrationApprovalInput(client)
            );
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
        resourceServerUrl: URL
    ): OAuthProtectedResourceMetadata {
        return {
            authorization_servers: [stripTrailingSlash(this.#issuerUrl.href)],
            resource: resourceUrlFromServerUrl(resourceServerUrl).href,
            resource_documentation: this.#config.documentationUrl,
            resource_name: this.#config.resourceName,
            scopes_supported: this.#config.requiredScopes.length === 0
                ? undefined
                : [...this.#config.requiredScopes]
        };
    }

    protectedResourceMetadataHandler(
        resourceServerUrl: URL
    ): RequestHandler {
        return async (_request: Request, response: Response) => {
            response.json(this.protectedResourceMetadata(resourceServerUrl));
        };
    }

    requestAuthHandler(resourceServerUrl: URL): RequestHandler {
        return requireBearerAuth({
            requiredScopes: this.#config.requiredScopes,
            resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(
                resourceServerUrl
            ),
            verifier: new McpOAuthResourceVerifier(
                this.provider,
                resourceServerUrl
            )
        });
    }
}

class McpOAuthResourceVerifier implements OAuthTokenVerifier {
    readonly #expectedResourceUrl: URL;
    readonly #provider: Provider;

    constructor(provider: Provider, expectedResourceUrl: URL) {
        this.#provider = provider;
        this.#expectedResourceUrl = resourceUrlFromServerUrl(
            expectedResourceUrl
        );
    }

    async verifyAccessToken(token: string) {
        const accessToken = await this.#provider.AccessToken.find(token);
        if (accessToken === undefined || accessToken.isValid !== true) {
            throw new InvalidTokenError("Token is invalid or expired.");
        }

        const resource = readTokenResource(accessToken.aud);
        if (
            resource !== undefined &&
            checkResourceAllowed({
                configuredResource: this.#expectedResourceUrl,
                requestedResource: resource
            }) === false
        ) {
            throw new InvalidTokenError(
                `Token resource ${resource.href} is not valid for ${this.#expectedResourceUrl.href}.`
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

        return {
            clientId: accessToken.clientId,
            expiresAt: accessToken.exp,
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

function readTokenResource(
    audience: string | string[] | undefined
): URL | undefined {
    const values = typeof audience === "string"
        ? [audience]
        : Array.isArray(audience)
            ? audience
            : [];
    for (const value of values) {
        try {
            return new URL(value);
        } catch {
            continue;
        }
    }
    return undefined;
}

function toRegistrationApprovalInput(client: unknown): OAuthApprovalInput {
    const value = client as {
        clientId?: unknown;
        clientName?: unknown;
        redirectUris?: unknown;
    };
    return {
        clientId: typeof value.clientId === "string"
            ? value.clientId
            : "unknown-client",
        clientName: readClientName(value.clientId, value.clientName),
        redirectUris: readStringArray(value.redirectUris)
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
        return JSON.parse(await readFile(jwksPath, "utf8")) as {
            keys: Array<Record<string, unknown>>;
        };
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
    await writeFile(jwksPath, JSON.stringify(jwks), "utf8");
    return jwks;
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT";
}
