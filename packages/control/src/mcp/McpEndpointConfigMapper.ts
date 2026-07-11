import type { McpHostInstanceConfig } from "@portable-devshell/mcp";

import type { InstanceDescriptor } from "../instance/InstanceDescriptor.js";

export class McpEndpointConfigMapper {
    map(descriptor: InstanceDescriptor): McpHostInstanceConfig {
        return {
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
