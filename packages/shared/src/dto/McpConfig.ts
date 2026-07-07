import type { AuthConfig } from "./AuthConfig.js";

export interface McpConfig {
    enabled: boolean;
    publicExposure: boolean;
    auth?: AuthConfig;
}
