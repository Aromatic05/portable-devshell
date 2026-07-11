import type { McpHostInstanceConfig, McpInstanceGateway } from "@portable-devshell/mcp";

import type { InstanceDescriptor } from "../instance/InstanceDescriptor.js";

export class McpEndpointConfigMapper {
    map(descriptor: InstanceDescriptor, gateway?: McpInstanceGateway): McpHostInstanceConfig {
        return {
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
