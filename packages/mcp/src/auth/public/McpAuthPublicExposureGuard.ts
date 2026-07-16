import { McpAuthPublicBaseUrlValidator } from "./McpAuthPublicBaseUrlValidator.js";

export interface McpExposureConfig {
    auth?: {
        enabled: boolean;
        provider: string;
    };
    listenHost: string;
    publicBaseUrl?: string;
}

export class McpAuthPublicExposureGuard {
    readonly #validator = new McpAuthPublicBaseUrlValidator();

    assertSafe(config: McpExposureConfig): void {
        const authEnabled = config.auth?.enabled === true && config.auth.provider !== "none";
        const hostIsPublic = config.listenHost === "0.0.0.0";
        const baseUrlIsPublic = this.#validator.isLocalhost(config.publicBaseUrl) === false;

        if (!authEnabled && (hostIsPublic || baseUrlIsPublic)) {
            const error = new Error("Public MCP exposure requires authentication.");
            Object.assign(error, {
                code: "mcp.publicAuthRequired",
                details: {
                    listenHost: config.listenHost,
                    publicBaseUrl: config.publicBaseUrl
                },
                retryable: false
            });
            throw error;
        }
    }
}
