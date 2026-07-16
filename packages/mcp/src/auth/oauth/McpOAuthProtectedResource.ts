import { mkdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";

import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import { exportJWK, generateKeyPair } from "jose";
import Provider from "oidc-provider";

import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

import type { McpOAuth2Config } from "../McpAuthConfig.js";
import { createMcpOAuthOidcFileAdapterFactory } from "./McpOAuthOidcFileAdapter.js";
import { McpOAuthApprovalService, type OAuthApprovalInput } from "./McpOAuthApprovalService.js";

type ProviderGrant = InstanceType<Provider["Grant"]>;

export class McpOAuthProtectedResource {
    readonly #accountId = readLocalAccountId();
    readonly #basePath: string;
    readonly #config: McpOAuth2Config;
    readonly #issuerUrl: URL;
    readonly #approvals: McpOAuthApprovalService;
    readonly #registeredResources = new Set<string>();
    readonly #storageDir: string;
    readonly #trustProxy: boolean;
    #provider?: Provider;

    constructor(config: McpOAuth2Config, publicBaseUrl: string, storageDir: string, options?: { trustProxy?: boolean }) {
        this.#config = config;
        this.#issuerUrl = new URL(publicBaseUrl);
        this.#basePath = normalizeBasePath(this.#issuerUrl.pathname);
        this.#storageDir = storageDir;
        this.#trustProxy = options?.trustProxy ?? false;
        this.#approvals = new McpOAuthApprovalService(storageDir);
    }

    get approvals(): McpOAuthApprovalService {
        return this.#approvals;
    }

    registerResource(resourceServerUrl: URL): void {
        this.#registeredResources.add(resourceUrlFromServerUrl(resourceServerUrl).href);
    }

    async warmup(): Promise<void> {
        if (this.#provider !== undefined) {
            return;
        }

        await mkdir(this.#storageDir, { recursive: true });
        await this.#approvals.warmup();
        const jwks = await readOrCreateJwks(this.#storageDir);

        this.#provider = new Provider(stripTrailingSlash(this.#issuerUrl.href), {
            adapter: createMcpOAuthOidcFileAdapterFactory(join(this.#storageDir, "adapter")),
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

                        throw new Error("Unable to determine a default resource indicator.");
                    },
                    enabled: true,
                    getResourceServerInfo: async (_ctx, resourceIndicator) => {
                        if (!this.#registeredResources.has(resourceIndicator)) {
                            throw new Error(`Unknown resource indicator: ${resourceIndicator}`);
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
                    async claims() {
                        return { sub: readLocalAccountId() };
                    }
                };
            },
            interactions: {
                url: async (_ctx, interaction) => `${this.#basePath}/interaction/${interaction.uid}`,
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
            scopes: ["openid", "offline_access", ...this.#config.requiredScopes],
            ttl: {
                AccessToken: () => 24 * 60 * 60,
                Grant: () => 30 * 24 * 60 * 60,
                IdToken: () => 60 * 60,
                Interaction: () => 10 * 60,
                Session: () => 30 * 24 * 60 * 60
            }
        });
        this.#provider.proxy = this.#trustProxy;
        this.#provider.on("registration_create.success", (_context, client) => {
            void this.#approvals.registerClient(toRegistrationApprovalInput(client));
        });
    }

    install(app: Express): void {
        const provider = this.#requireProvider();
        const parseForm = express.urlencoded({ extended: false });

        app.get(`${this.#basePath}/oauth/approvals/:approvalId`, async (request, response) => {
            const approval = await this.#approvals.get(request.params.approvalId);
            response.json({ status: approval?.status ?? "missing" });
        });

        app.get(this.#interactionRoute(), async (request, response) => {
            await this.#renderInteraction(provider, request, response);
        });
        app.post(this.#interactionRoute(), parseForm, async (request, response) => {
            await this.#submitInteraction(provider, request, response);
        });

        const callback = provider.callback();
        app.use((request, response, next) => {
            const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;

            if (!this.#shouldHandleProviderPath(pathname)) {
                next();
                return;
            }

            callback(request, response);
        });
    }

    protectedResourceMetadataHandler(resourceServerUrl: URL): RequestHandler {
        return async (_request: Request, response: Response) => {
            const metadata: OAuthProtectedResourceMetadata = {
                authorization_servers: [stripTrailingSlash(this.#issuerUrl.href)],
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
            verifier: new McpOAuthResourceVerifier(this.#requireProvider(), resourceServerUrl)
        });
    }

    #interactionRoute(): string {
        return `${this.#basePath}/interaction/:uid`;
    }

    #requireProvider(): Provider {
        if (this.#provider === undefined) {
            throw new Error("OIDC provider is not initialized. Call warmup() before install().");
        }

        return this.#provider;
    }

    #shouldHandleProviderPath(pathname: string): boolean {
        if (pathname.startsWith("/.well-known/")) {
            return true;
        }

        const authPrefixes = ["/authorize", "/jwks", "/register", "/revoke", "/session", "/token", "/userinfo"];
        return authPrefixes.some((prefix) => pathname.startsWith(`${this.#basePath}${prefix}`));
    }

    async #renderInteraction(provider: Provider, request: Request, response: Response): Promise<void> {
        const details = await provider.interactionDetails(request, response);
        const promptName = details.prompt.name;

        if (promptName !== "login" && promptName !== "consent") {
            response.status(501).type("text/plain").send(`unsupported interaction prompt: ${promptName}`);
            return;
        }

        const approval = await this.#approvals.requestAuthorization(String(details.uid), toAuthorizationApprovalInput(details));

        if (approval.status === "denied" || approval.status === "expired") {
            await this.#finishDeniedInteraction(provider, request, response, approval.status);
            return;
        }

        response.status(200).type("html").send(renderInteractionPage({
            accountId: this.#accountId,
            approvalId: approval.approvalId,
            approvalKind: approval.kind,
            approvalStatus: approval.status,
            clientName: readClientName(details.params.client_id, details.params.client_name),
            promptName,
            requiredScopes: readStringArray(details.prompt.details.missingOIDCScope),
            requestedResources: readRequestedResources(details.prompt.details.missingResourceScopes)
        }));
    }

    async #submitInteraction(provider: Provider, request: Request, response: Response): Promise<void> {
        const interaction = await provider.interactionDetails(request, response);
        const { prompt: { details, name }, grantId, params, session } = interaction;
        const approval = await this.#approvals.getAuthorization(String(interaction.uid));

        if (approval?.status !== "approved") {
            if (approval?.status === "pending") {
                response.status(409).type("text/plain").send("Administrator approval is still pending.");
                return;
            }

            await this.#finishDeniedInteraction(provider, request, response, approval?.status ?? "missing");
            return;
        }

        if (name === "login") {
            await provider.interactionFinished(
                request,
                response,
                {
                    login: { accountId: this.#accountId }
                },
                { mergeWithLastSubmission: false }
            );
            return;
        }

        if (name !== "consent") {
            response.status(501).type("text/plain").send(`unsupported interaction prompt: ${name}`);
            return;
        }

        let grant: ProviderGrant | undefined;

        if (grantId !== undefined) {
            grant = await provider.Grant.find(grantId);
        }

        if (grant === undefined) {
            grant = new provider.Grant({
                accountId: session?.accountId ?? this.#accountId,
                clientId: String(params.client_id)
            });
        }

        if (details.missingOIDCScope) {
            grant.addOIDCScope(readStringArray(details.missingOIDCScope).join(" "));
        }

        if (details.missingOIDCClaims) {
            grant.addOIDCClaims(readStringArray(details.missingOIDCClaims));
        }

        if (details.missingResourceScopes) {
            for (const [indicator, scopes] of Object.entries(details.missingResourceScopes)) {
                grant.addResourceScope(indicator, readStringArray(scopes).join(" "));
            }
        }

        await provider.interactionFinished(
            request,
            response,
            {
                consent: { grantId: await grant.save() }
            },
            { mergeWithLastSubmission: true }
        );
    }

    async #finishDeniedInteraction(provider: Provider, request: Request, response: Response, status: "denied" | "expired" | "missing"): Promise<void> {
        await provider.interactionFinished(
            request,
            response,
            {
                error: "access_denied",
                error_description: status === "expired" ? "Administrator approval expired." : "Administrator approval was denied."
            },
            { mergeWithLastSubmission: false }
        );
    }
}

class McpOAuthResourceVerifier implements OAuthTokenVerifier {
    readonly #expectedResourceUrl: URL;
    readonly #provider: Provider;

    constructor(provider: Provider, expectedResourceUrl: URL) {
        this.#provider = provider;
        this.#expectedResourceUrl = resourceUrlFromServerUrl(expectedResourceUrl);
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
            throw new InvalidTokenError(`Token resource ${resource.href} is not valid for ${this.#expectedResourceUrl.href}.`);
        }

        if (typeof accessToken.clientId !== "string" || accessToken.clientId.length === 0) {
            throw new ServerError("Issued access token does not include a client identifier.");
        }

        return {
            clientId: accessToken.clientId,
            expiresAt: accessToken.exp,
            extra: {
                subject: typeof (accessToken as { accountId?: unknown }).accountId === "string"
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

function readClientName(clientId: unknown, clientName: unknown): string {
    if (typeof clientName === "string" && clientName.length > 0) {
        return clientName;
    }

    if (typeof clientId === "string" && clientId.length > 0) {
        return clientId;
    }

    return "unknown-client";
}

function readLocalAccountId(): string {
    try {
        return userInfo().username;
    } catch {
        return "aromatic";
    }
}

function readRequestedResources(resources: unknown): Array<{ indicator: string; scopes: string[] }> {
    if (typeof resources !== "object" || resources === null || Array.isArray(resources)) {
        return [];
    }

    return Object.entries(resources)
        .map(([indicator, scopes]) => ({
            indicator,
            scopes: readStringArray(scopes)
        }))
        .filter(({ scopes }) => scopes.length > 0);
}

function readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.filter((entry): entry is string => typeof entry === "string");
}

function readTokenResource(audience: string | string[] | undefined): URL | undefined {
    const values = typeof audience === "string" ? [audience] : Array.isArray(audience) ? audience : [];

    for (const value of values) {
        try {
            return new URL(value);
        } catch {
            continue;
        }
    }

    return undefined;
}

function renderInteractionPage(input: {
    accountId: string;
    approvalId: string;
    approvalKind: "authorization" | "registration";
    approvalStatus: "approved" | "pending";
    clientName: string;
    promptName: "consent" | "login";
    requestedResources: Array<{ indicator: string; scopes: string[] }>;
    requiredScopes: string[];
}): string {
    const scopes = input.requiredScopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("");
    const resources = input.requestedResources
        .map(
            ({ indicator, scopes: requestedScopes }) =>
                `<li><strong>${escapeHtml(indicator)}</strong><ul>${requestedScopes
                    .map((scope) => `<li>${escapeHtml(scope)}</li>`)
                    .join("")}</ul></li>`
        )
        .join("");

    const title = input.promptName === "login" ? "Sign In" : "Authorize";
    const action = input.promptName === "login" ? "Continue as aromatic" : "Approve access";
    const waiting = input.approvalStatus === "pending";
    const approvedAction = input.approvalKind === "registration" ? "window.location.reload();" : "form.submit();";

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; background: #f6f5ef; color: #1e1b16; margin: 0; padding: 32px 16px; }
    main { max-width: 720px; margin: 0 auto; background: #fffdf7; border: 1px solid #ddd3c1; border-radius: 16px; padding: 24px; box-shadow: 0 12px 40px rgba(30, 27, 22, 0.08); }
    h1 { margin-top: 0; font-size: 28px; }
    p, li { line-height: 1.5; }
    button { border: 0; border-radius: 999px; background: #1e1b16; color: #fffdf7; padding: 12px 20px; font-size: 16px; cursor: pointer; }
    ul { margin-top: 8px; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p><strong>${escapeHtml(input.clientName)}</strong> is requesting access as <strong>${escapeHtml(input.accountId)}</strong>.</p>
    ${scopes.length > 0 ? `<p>Scopes:</p><ul>${scopes}</ul>` : ""}
    ${resources.length > 0 ? `<p>Resource access:</p><ul>${resources}</ul>` : ""}
    <p id="approval-status">${waiting ? "Waiting for administrator approval." : "Administrator approved this request."}</p>
    <form id="interaction-form" method="post">
      <button type="submit" ${waiting ? "disabled" : ""}>${action}</button>
    </form>
    <script>
      const status = document.getElementById("approval-status");
      const form = document.getElementById("interaction-form");
      async function checkApproval() {
        const response = await fetch("${escapeHtml(`/oauth/approvals/${input.approvalId}`)}", { cache: "no-store" });
        const payload = await response.json();
        if (payload.status === "approved") {
          ${approvedAction}
          return;
        }
        if (payload.status === "denied" || payload.status === "expired" || payload.status === "missing") {
          status.textContent = "Administrator approval was not granted.";
          return;
        }
        setTimeout(checkApproval, 1000);
      }
      checkApproval();
    </script>
  </main>
</body>
</html>`;
}

function toRegistrationApprovalInput(client: unknown): OAuthApprovalInput {
    const value = client as { clientId?: unknown; clientName?: unknown; redirectUris?: unknown };
    return {
        clientId: typeof value.clientId === "string" ? value.clientId : "unknown-client",
        clientName: readClientName(value.clientId, value.clientName),
        redirectUris: readStringArray(value.redirectUris)
    };
}

function toAuthorizationApprovalInput(details: Awaited<ReturnType<Provider["interactionDetails"]>>): OAuthApprovalInput {
    return {
        clientId: typeof details.params.client_id === "string" ? details.params.client_id : "unknown-client",
        clientName: readClientName(details.params.client_id, details.params.client_name),
        redirectUris: typeof details.params.redirect_uri === "string" ? [details.params.redirect_uri] : [],
        requestedResources: typeof details.params.resource === "string" ? [details.params.resource] : [],
        requestedScopes: typeof details.params.scope === "string" ? details.params.scope.split(/\s+/u).filter((scope) => scope.length > 0) : []
    };
}

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function stripTrailingSlash(value: string): string {
    return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function readOrCreateJwks(storageDir: string): Promise<{ keys: Array<Record<string, unknown>> }> {
    const jwksPath = join(storageDir, "jwks.json");

    try {
        return JSON.parse(await readFile(jwksPath, "utf8")) as { keys: Array<Record<string, unknown>> };
    } catch (error) {
        if (!isMissing(error)) {
            throw error;
        }
    }

    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(privateKey);
    jwk.alg = "RS256";
    jwk.kid = "aromatic-oidc-signing-key";
    jwk.use = "sig";

    const jwks = { keys: [jwk as unknown as Record<string, unknown>] };
    await writeFile(jwksPath, JSON.stringify(jwks), "utf8");
    return jwks;
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
