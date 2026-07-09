import type { Request, RequestHandler, Response } from "express";

import { discoverAuthorizationServerMetadata } from "@modelcontextprotocol/sdk/client/auth.js";
import {
    InvalidTokenError,
    ServerError
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type {
    AuthorizationServerMetadata,
    OAuthProtectedResourceMetadata
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTPayload, type JWTVerifyGetKey } from "jose";

import type { McpOAuth2Config } from "../McpAuthConfig.js";

interface McpOAuthState {
    authorizationServerMetadata: AuthorizationServerMetadata;
    jwksUri: string;
    keySet: JWTVerifyGetKey;
}

export class McpOAuthProtectedResource {
    readonly #config: McpOAuth2Config;
    readonly #verifier: McpOAuthTokenVerifier;

    constructor(config: McpOAuth2Config) {
        this.#config = config;
        this.#verifier = new McpOAuthTokenVerifier(config);
    }

    async warmup(): Promise<void> {
        await this.#verifier.warmup();
    }

    authorizationServerMetadataHandler(): RequestHandler {
        return async (_request: Request, response: Response) => {
            const state = await this.#verifier.readState();
            response.json(state.authorizationServerMetadata);
        };
    }

    protectedResourceMetadataHandler(resourceServerUrl: URL): RequestHandler {
        return async (_request: Request, response: Response) => {
            const state = await this.#verifier.readState();
            const metadata: OAuthProtectedResourceMetadata = {
                authorization_servers: [state.authorizationServerMetadata.issuer],
                jwks_uri: state.jwksUri,
                resource: resourceUrlFromServerUrl(resourceServerUrl).href,
                resource_documentation: this.#config.documentationUrl,
                resource_name: this.#config.resourceName,
                scopes_supported: this.#config.requiredScopes.length === 0 ? undefined : [...this.#config.requiredScopes]
            };

            response.json(metadata);
        };
    }

    requestAuthHandler(resourceServerUrl: URL): RequestHandler {
        return requireBearerAuth({
            requiredScopes: this.#config.requiredScopes,
            resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
            verifier: new McpOAuthResourceVerifier(this.#verifier, resourceServerUrl)
        });
    }
}

class McpOAuthTokenVerifier implements OAuthTokenVerifier {
    readonly #config: McpOAuth2Config;
    #statePromise?: Promise<McpOAuthState>;

    constructor(config: McpOAuth2Config) {
        this.#config = config;
    }

    async warmup(): Promise<void> {
        await this.readState();
    }

    async readState(): Promise<McpOAuthState> {
        if (this.#statePromise === undefined) {
            this.#statePromise = this.#loadState();
        }

        return await this.#statePromise;
    }

    async verifyAccessToken(token: string) {
        const state = await this.readState();

        try {
            const { payload } = await jwtVerify(token, state.keySet, {
                audience: this.#config.audience,
                issuer: this.#config.issuer
            });

            return {
                clientId: readClientId(payload),
                expiresAt: typeof payload.exp === "number" ? payload.exp : undefined,
                extra: payload,
                resource: readResource(payload),
                scopes: readScopes(payload),
                token
            };
        } catch (error) {
            if (error instanceof joseErrors.JWTExpired || error instanceof joseErrors.JWTClaimValidationFailed) {
                throw new InvalidTokenError(readErrorMessage(error));
            }

            if (error instanceof joseErrors.JWKSInvalid || error instanceof joseErrors.JWKSNoMatchingKey) {
                throw new InvalidTokenError(readErrorMessage(error));
            }

            if (error instanceof joseErrors.JWTInvalid || error instanceof joseErrors.JOSEError) {
                throw new InvalidTokenError(readErrorMessage(error));
            }

            throw new ServerError(readErrorMessage(error, "OAuth token verification failed."));
        }
    }

    async #loadState(): Promise<McpOAuthState> {
        const metadata = await discoverAuthorizationServerMetadata(this.#config.issuer);

        if (metadata === undefined) {
            throw new Error(`Unable to discover authorization server metadata for issuer ${this.#config.issuer}.`);
        }

        const discoveredIssuer = canonicalIssuer(metadata.issuer);
        const configuredIssuer = canonicalIssuer(this.#config.issuer);

        if (discoveredIssuer !== configuredIssuer) {
            throw new Error(`Discovered issuer ${metadata.issuer} does not match configured issuer ${this.#config.issuer}.`);
        }

        const jwksUri =
            this.#config.jwksUri ??
            ("jwks_uri" in metadata && typeof metadata.jwks_uri === "string" ? metadata.jwks_uri : undefined);

        if (jwksUri === undefined) {
            throw new Error(
                `Authorization server ${metadata.issuer} did not publish jwks_uri. Configure mcp.auth.oauth2.jwksUri explicitly.`
            );
        }

        return {
            authorizationServerMetadata: metadata,
            jwksUri,
            keySet: createRemoteJWKSet(new URL(jwksUri))
        };
    }
}

class McpOAuthResourceVerifier implements OAuthTokenVerifier {
    readonly #expectedResourceUrl: URL;
    readonly #verifier: McpOAuthTokenVerifier;

    constructor(verifier: McpOAuthTokenVerifier, expectedResourceUrl: URL) {
        this.#verifier = verifier;
        this.#expectedResourceUrl = resourceUrlFromServerUrl(expectedResourceUrl);
    }

    async verifyAccessToken(token: string) {
        const authInfo = await this.#verifier.verifyAccessToken(token);

        if (
            authInfo.resource !== undefined &&
            checkResourceAllowed({
                configuredResource: this.#expectedResourceUrl,
                requestedResource: authInfo.resource
            }) === false
        ) {
            throw new InvalidTokenError(`Token resource ${authInfo.resource.href} is not valid for ${this.#expectedResourceUrl.href}.`);
        }

        return authInfo;
    }
}

function canonicalIssuer(source: string): string {
    const url = new URL(source);
    const href = url.href;
    return href.endsWith("/") ? href.slice(0, -1) : href;
}

function readClientId(payload: JWTPayload): string {
    const candidates = [payload.client_id, payload.azp, payload.sub];

    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.length > 0) {
            return candidate;
        }
    }

    throw new InvalidTokenError("Token does not include a usable client identifier.");
}

function readResource(payload: JWTPayload): URL | undefined {
    const value = payload.resource;

    if (typeof value !== "string" || value.length === 0) {
        return undefined;
    }

    try {
        return new URL(value);
    } catch {
        throw new InvalidTokenError(`Token resource claim is not a valid URL: ${value}`);
    }
}

function readScopes(payload: JWTPayload): string[] {
    const scopes = new Set<string>();

    if (typeof payload.scope === "string") {
        for (const scope of payload.scope.split(/\s+/u)) {
            if (scope.length > 0) {
                scopes.add(scope);
            }
        }
    }

    if (typeof payload.scp === "string" && payload.scp.length > 0) {
        scopes.add(payload.scp);
    }

    if (Array.isArray(payload.scp)) {
        for (const scope of payload.scp) {
            if (typeof scope === "string" && scope.length > 0) {
                scopes.add(scope);
            }
        }
    }

    return [...scopes];
}

function readErrorMessage(error: unknown, fallback = "Unknown error"): string {
    return error instanceof Error ? error.message : fallback;
}
