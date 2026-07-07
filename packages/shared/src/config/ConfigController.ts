import type { AuthConfig } from "./ConfigAuth.js";
import type { InstanceConfig } from "./ConfigInstance.js";
import type { McpConfig } from "./ConfigMcp.js";

export interface ControllerConfig {
    auth?: AuthConfig;
    instances: InstanceConfig[];
    mcp: McpConfig;
}
