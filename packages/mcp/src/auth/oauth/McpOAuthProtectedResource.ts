import type {
    Express,
    RequestHandler
} from "express";
import type { OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

import type { McpOAuth2Config } from "../McpAuthConfig.js";
import { McpOAuthApprovalService } from "./McpOAuthApprovalService.js";
import { McpOAuthInteraction } from "./McpOAuthInteraction.js";
import { McpOAuthProviderRuntime } from "./McpOAuthProviderRuntime.js";

export interface McpOAuthProtectedResourceOptions {
    trustProxy?: boolean;
}

export class McpOAuthProtectedResource {
    readonly #approvals: McpOAuthApprovalService;
    readonly #interaction: McpOAuthInteraction;
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

    registerResource(resourceServerUrl: URL): void {
        this.#runtime.registerResource(resourceServerUrl);
    }

    async warmup(): Promise<void> {
        await this.#runtime.warmup();
    }

    install(app: Express): void {
        this.#interaction.install(app);
        this.#installProvider(app);
    }

    protectedResourceMetadataHandler(
        resourceServerUrl: URL
    ): RequestHandler {
        return this.#runtime.protectedResourceMetadataHandler(
            resourceServerUrl
        );
    }

    protectedResourceMetadata(
        resourceServerUrl: URL
    ): OAuthProtectedResourceMetadata {
        return this.#runtime.protectedResourceMetadata(
            resourceServerUrl
        );
    }

    requestAuthHandler(resourceServerUrl: URL): RequestHandler {
        return this.#runtime.requestAuthHandler(resourceServerUrl);
    }

    #installProvider(app: Express): void {
        const callback = this.#runtime.provider.callback();
        app.use((request, response, next) => {
            if (!this.#shouldHandleRequest(request.url)) {
                next();
                return;
            }
            callback(request, response);
        });
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
