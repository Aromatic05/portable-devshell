import type { McpOAuth2Config, McpOAuthApprovalConfig } from './Config.js';
import { McpOAuthApprovalService } from './interaction/Approval.js';
import { McpOAuthProtectedResource } from './Resource.js';

/** Owns OAuth approvals and providers independently of replaceable MCP HTTP listeners. */
export class McpOAuthRuntime {
    readonly approvals?: McpOAuthApprovalService;
    readonly #resources = new Map<string, McpOAuthProtectedResource>();

    constructor(storageDir?: string) {
        this.approvals = storageDir === undefined ? undefined : new McpOAuthApprovalService(storageDir);
    }

    resource(config: McpOAuth2Config, publicBaseUrl: string, storageDir: string,
        approval: McpOAuthApprovalConfig, trustProxy: boolean): McpOAuthProtectedResource {
        const origin = new URL(publicBaseUrl).origin;
        const key = JSON.stringify({
            documentationUrl: config.documentationUrl ?? null,
            approval,
            origin,
            requiredScopes: [...config.requiredScopes].sort(),
            resourceName: config.resourceName,
            storageDir,
            trustProxy,
        });
        let resource = this.#resources.get(key);
        if (resource !== undefined) return resource;
        resource = new McpOAuthProtectedResource(config, origin, storageDir, {
            approval,
            ...(this.approvals === undefined ? {} : { approvals: this.approvals }),
            trustProxy,
        });
        this.#resources.set(key, resource);
        return resource;
    }
}
