import type { ToolDefinition } from "@portable-devshell/shared";

import { instanceConnectOutputSchema } from "../McpToolOutputSchemas.js";

export type McpToolCatalogInstanceName = "instance_connect";

export class McpToolCatalogInstance {
    list(): ToolDefinition[] {
        return [instanceConnectTool()];
    }
}

function instanceConnectTool(): ToolDefinition {
    return {
        description: "Bind the current MCP Context to another already-managed instance/workspace. This is a runtime Context bootstrap primitive; it does not create, delete, start, stop, or configure instances.",
        group: "instance",
        inputSchema: {
            additionalProperties: false,
            properties: {
                instance: {
                    description: "Managed instance name from devshell instance list.",
                    minLength: 1,
                    type: "string"
                },
                workspace: {
                    description: "Optional absolute workspace path to attach to this Context on the target instance.",
                    minLength: 1,
                    type: "string"
                }
            },
            required: ["instance"],
            type: "object"
        },
        name: "instance_connect",
        outputSchema: instanceConnectOutputSchema,
        requiredCapabilities: []
    };
}
