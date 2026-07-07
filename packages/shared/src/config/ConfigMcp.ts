import type { AuthConfig } from "./ConfigAuth.js";

export interface McpConfig {
    enabled: boolean;
    publicExposure: boolean;
    auth?: AuthConfig;
}
