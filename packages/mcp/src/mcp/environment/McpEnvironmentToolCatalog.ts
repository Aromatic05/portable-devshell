import type { ToolDefinition } from "@portable-devshell/shared";

export const mcpEnvironmentToolName = "environ_info" as const;

export class McpEnvironmentToolCatalog {
    list(): ToolDefinition[] {
        return [{
            description: "Create a persistent invocation context and return the essential target environment.",
            group: "environment",
            inputSchema: {
                additionalProperties: false,
                properties: {},
                type: "object"
            },
            name: mcpEnvironmentToolName,
            outputSchema: {
                additionalProperties: false,
                properties: {
                    ctxId: { minLength: 1, type: "string" },
                    expiresAt: { minLength: 1, type: "string" },
                    instance: { minLength: 1, type: "string" },
                    platform: { type: "object" },
                    workspace: { minLength: 1, type: "string" }
                },
                required: ["ctxId", "expiresAt", "instance", "workspace", "platform"],
                type: "object"
            },
            requiredCapabilities: []
        }];
    }
}
