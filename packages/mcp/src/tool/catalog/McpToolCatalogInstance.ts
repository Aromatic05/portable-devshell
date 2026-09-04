import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

import { instanceConnectOutputSchema } from "../McpToolOutputSchemas.js";

export type McpToolCatalogInstanceName = "instance_connect";

const instanceConnectSchema: JsonValue = {
    additionalProperties: false,
    properties: {
        instance: {
            description: "Managed instance name from devshell instance list.",
            minLength: 1,
            type: "string"
        },
        workspace: {
            description: "Optional absolute workspace path to attach to this session context on the target instance.",
            minLength: 1,
            type: "string"
        }
    },
    required: ["instance"],
    type: "object"
};

export class McpToolCatalogInstance {
    readonly #definitions: readonly ToolDefinition[] = [{
        description: "Ensure a managed instance is ready and optionally attach an absolute workspace to this session context. The operation is idempotent. Omitting workspace is sufficient for instance-level operations; worker tools on that target require a workspace attachment, so provide an absolute workspace to satisfy mcp.contextWorkspaceRequired for cross-instance work.",
        group: "instance",
        inputSchema: instanceConnectSchema,
        name: "instance_connect",
        outputSchema: instanceConnectOutputSchema,
        requiredCapabilities: ["manage"]
    }];

    list(): ToolDefinition[] {
        return this.#definitions.map((definition) => ({ ...definition }));
    }

    get(name: string): ToolDefinition | undefined {
        return this.#definitions.find((definition) => definition.name === name);
    }

    isInstanceTool(name: string): name is McpToolCatalogInstanceName {
        return this.get(name) !== undefined;
    }
}
