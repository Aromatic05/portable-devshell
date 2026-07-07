import type { AuthConfig } from "./AuthConfig.js";
import type { InstanceConfig } from "./InstanceConfig.js";
import type { McpConfig } from "./McpConfig.js";

export interface ControllerConfig {
    auth?: AuthConfig;
    instances: InstanceConfig[];
    mcp: McpConfig;
}
