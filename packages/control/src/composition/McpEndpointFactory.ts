import type { McpAuthConfig, McpHostInstanceConfig, McpInstanceGateway } from "@portable-devshell/mcp";
import type { ControlMcpAuthConfig } from "@portable-devshell/shared";

import type { InstanceDescriptor } from "../control/instance/InstanceDescriptor.js";

export class McpEndpointFactory {
    map(descriptor: InstanceDescriptor, gateway?: McpInstanceGateway, auth: ControlMcpAuthConfig = { mode: "none" }): McpHostInstanceConfig {
        return {
            auth: toMcpAuthConfig(auth),
            contextMode: descriptor.mcpContextMode ?? "explicit",
            ...(gateway === undefined ? {} : { gateway }),
            policy: {
                capabilities: descriptor.mcpCapabilities,
                groups: descriptor.mcpGroups
            },
            name: descriptor.name,
            path: descriptor.mcpPath,
            worker: descriptor.worker
        };
    }
}

function toMcpAuthConfig(auth: ControlMcpAuthConfig): McpAuthConfig {
    if (auth.mode === "none") return { enabled: false, provider: "none" };
    if (auth.mode === "token") return { enabled: true, provider: "token", token: auth.token };
    return { enabled: true, provider: "oauth2", oauth2: auth.oauth2 };
}
