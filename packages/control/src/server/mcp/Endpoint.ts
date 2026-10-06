import type {
    McpAuthConfig,
    McpHostInstanceConfig,
} from "@portable-devshell/mcp";
import type { ControlMcpAuthConfig } from "@portable-devshell/shared";

import type { Instance } from "@portable-devshell/core";

export class McpEndpointFactory {
    map(
        descriptor: Instance,
        auth: ControlMcpAuthConfig = { mode: "none" },
    ): McpHostInstanceConfig {
        return {
            auth: toMcpAuthConfig(auth),
            contextMode: descriptor.mcpContextMode ?? "explicit",
            name: descriptor.name,
            path: descriptor.mcpPath,
        };
    }
}

function toMcpAuthConfig(auth: ControlMcpAuthConfig): McpAuthConfig {
    if (auth.mode === "none") return { enabled: false, provider: "none" };
    if (auth.mode === "token")
        return { enabled: true, provider: "token", token: auth.token };
    return { enabled: true, provider: "oauth2", oauth2: auth.oauth2 };
}
