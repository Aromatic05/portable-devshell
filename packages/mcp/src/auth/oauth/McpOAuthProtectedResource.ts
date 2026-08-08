import type {
    Express,
    RequestHandler
} from "express";
import type { OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

import type { McpOAuth2Config } from "../McpAuthConfig.js";
import { McpOAuthApprovalService } from "./McpOAuthApprovalService.js";
import { McpOAuthInteraction } from "./McpOAuthInteraction.js";
import {
    McpOAuthProviderRuntime,
    type McpOAuthAccessRevocation,
    type McpOAuthAccessTokenVerification
} from "./McpOAuthProviderRuntime.js";
import { McpOAuthRegistrationLimiter } from "./McpOAuthRegistrationLimiter.js";

export interface McpOAuthProtectedResourceOptions {
    trustProxy?: boolean;
}

export class McpOAuthProtectedResource {
    readonly #approvals: McpOAuthApprovalService;
    readonly #interaction: McpOAuthInteraction;
    readonly #registrationLimiter = new McpOAuthRegistrationLimiter();
    readonly #runtime: McpOAuthProviderRuntime;

    constructor(
        config: McpOAuth2Config,
        publicBaseUrl: string,
        storageDir: string,
        options: McpOAuthProtectedResourceOptions = {}
    ) {
        this.#approvals = new McpOAuthApprovalService(storageDir);
        this.#runtime = new McpOAuthProviderRuntime({
            approvals: this.#approvals,
            config,
            publicBaseUrl,
            storageDir,
            trustProxy: options.trustProxy
        });
        this.#interaction = new McpOAuthInteraction({
            accountId: this.#runtime.accountId,
            approvals: this.#approvals,
            basePath: this.#runtime.basePath,
            provider: () => this.#runtime.provider
        });
    }

    get approvals(): McpOAuthApprovalService {
        return this.#approvals;
    }

    get issuerUrl(): URL {
        return this.#runtime.issuerUrl;
    }

    registerResource(resourceServerUrl: URL, config: McpOAuth2Config): void {
        this.#runtime.registerResource(resourceServerUrl, config);
    }

    onAccessRevoked(listener: (revocation: McpOAuthAccessRevocation) => void): () => void {
        return this.#runtime.onAccessRevoked(listener);
    }

    async verifyAccessToken(
        resourceServerUrl: URL,
        token: string
    ): Promise<McpOAuthAccessTokenVerification> {
        return await this.#runtime.verifyAccessToken(resourceServerUrl, token);
    }

    async warmup(): Promise<void> {
        await this.#runtime.warmup();
    }

    install(app: Express): void {
        this.#installRegistrationGuard(app);
        this.#interaction.install(app);
        this.#installProvider(app);
    }

    protectedResourceMetadataHandler(
        resourceServerUrl: URL,
        config?: McpOAuth2Config
    ): RequestHandler {
        return this.#runtime.protectedResourceMetadataHandler(
            resourceServerUrl,
            config
        );
    }

    protectedResourceMetadata(
        resourceServerUrl: URL,
        config?: McpOAuth2Config
    ): OAuthProtectedResourceMetadata {
        return this.#runtime.protectedResourceMetadata(
            resourceServerUrl,
            config
        );
    }

    requestAuthHandler(resourceServerUrl: URL, config?: McpOAuth2Config): RequestHandler {
        return this.#runtime.requestAuthHandler(resourceServerUrl, config);
    }

    #installProvider(app: Express): void {
        app.use((request, response, next) => {
            if (!this.#shouldHandleRequest(request.url)) {
                next();
                return;
            }
            this.#ensureOfflineConsent(request);
            this.#runtime.provider.callback()(request, response);
        });
    }

    #installRegistrationGuard(app: Express): void {
        const registrationPath = `${this.#runtime.basePath}/register`;
        app.use((request, response, next) => {
            const pathname = this.#requestPathname(request.url);
            if (request.method !== "POST" || pathname !== registrationPath) {
                next();
                return;
            }
            const key = request.socket.remoteAddress ?? "unknown";
            if (!this.#registrationLimiter.accept(key)) {
                response.setHeader("retry-after", "60");
                response.status(429).json({ error: "OAuth client registration rate limit exceeded." });
                return;
            }
            next();
        });
    }

    #ensureOfflineConsent(request: { url?: string }): void {
        const current = new URL(request.url ?? "/", "http://127.0.0.1");
        if (current.pathname !== `${this.#runtime.basePath}/authorize`) return;
        const scopes = new Set((current.searchParams.get("scope") ?? "").split(/\s+/u).filter(Boolean));
        if (!scopes.has("offline_access")) return;
        const prompts = new Set((current.searchParams.get("prompt") ?? "").split(/\s+/u).filter(Boolean));
        if (prompts.has("consent")) return;
        prompts.add("consent");
        current.searchParams.set("prompt", [...prompts].join(" "));
        request.url = `${current.pathname}${current.search}`;
    }

    #shouldHandleRequest(requestUrl: string | undefined): boolean {
        return this.#runtime.shouldHandleProviderPath(
            this.#requestPathname(requestUrl)
        );
    }

    #requestPathname(requestUrl: string | undefined): string {
        return new URL(
            requestUrl ?? "/",
            "http://127.0.0.1"
        ).pathname;
    }
}
