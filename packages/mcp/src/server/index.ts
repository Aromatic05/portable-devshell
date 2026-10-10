import type { ContextTransport, Endpoint, ToolCallApi } from "@portable-devshell/shared";
import type { McpOAuth2Config, McpOAuthApprovalConfig } from "../oauth/Config.js";
import { McpOAuthRuntime } from "../oauth/index.js";
import { McpProtocolRuntime } from "../protocol/index.js";
import type { McpOAuthProtectedResource } from "../oauth/Route.js";
import { McpAppRuntime } from "../mcpapp/index.js";

/** Composes Domain owners across MCP listener replacement; owns no domain stores directly. */
export class McpServer {
    readonly context: Pick<ContextTransport, "resolve" | "validateForInstance">;
    readonly tools: ToolCallApi;
    readonly oauth: McpOAuthRuntime;
    readonly protocol?: McpProtocolRuntime;
    readonly app: McpAppRuntime;

    constructor(config: {
        context: Pick<ContextTransport, "resolve" | "validateForInstance">;
        endpoint?: Endpoint;
        tools: ToolCallApi;
        storageDir?: string;
        mcpAppLeaseFile?: string;
        toolProvenanceFile?: string;
    }) {
        this.context = config.context;
        this.tools = config.tools;
        this.oauth = new McpOAuthRuntime(config.storageDir);
        this.protocol =
            config.toolProvenanceFile === undefined
                ? undefined
                : new McpProtocolRuntime(config.toolProvenanceFile);
        this.app = new McpAppRuntime({
            ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
            ...(config.mcpAppLeaseFile === undefined ? {} : { filePath: config.mcpAppLeaseFile }),
        });
    }

    initialize(): Promise<void> {
        return this.app.initialize();
    }
    async close(): Promise<void> {
        const failures: unknown[] = [];
        await this.app.close().catch((error) => failures.push(error));
        try { this.oauth.close(); } catch (error) { failures.push(error); }
        await this.protocol?.close().catch((error) => failures.push(error));
        if (failures.length > 0) throw new AggregateError(failures, 'MCP Domain shutdown was incomplete');
    }
    get oauthApprovals() {
        return this.oauth.approvals;
    }
    get mcpAppLeases() {
        return this.app.leases;
    }
    get workspaceActions() {
        return this.app.actions;
    }
    get mcpAppPresence() {
        return this.app.presence;
    }
    get mcpAppView() {
        return this.app.view;
    }

    oauthResource(
        config: McpOAuth2Config,
        publicBaseUrl: string,
        storageDir: string,
        approval: McpOAuthApprovalConfig,
        trustProxy: boolean,
    ): McpOAuthProtectedResource {
        return this.oauth.resource(config, publicBaseUrl, storageDir, approval, trustProxy);
    }
}
