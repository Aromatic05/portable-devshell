import type { ToolDefinition } from "@portable-devshell/shared";

export const mcpEnvironmentToolName = "environ_info" as const;

export class McpToolCatalogEnvironment {
    list(): ToolDefinition[] {
        return [{
            description: "Create a workspace session context on the current instance. Call before other tools, then pass ctxId to later tools; create a new context only when the previous ctxId is unavailable or expired.",
            group: "environment",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    workspace: {
                        description: "Absolute path to the workspace on the worker machine.",
                        minLength: 1,
                        type: "string"
                    }
                },
                required: ["workspace"],
                type: "object"
            },
            name: mcpEnvironmentToolName,
            outputSchema: {
                additionalProperties: false,
                properties: {
                    ctxId: { description: "Session context ID.", minLength: 1, type: "string" },
                    expiresAt: { description: "Context expiration time.", minLength: 1, type: "string" },
                    comment: {
                        description: "Actionable notes.",
                        items: { minLength: 1, type: "string" },
                        type: "array"
                    },
                    instance: { minLength: 1, type: "string" },
                    platform: { type: "object" },
                    projectMemoryAgentFile: { minLength: 1, type: "string" },
                    projectMemoryDirectory: { minLength: 1, type: "string" },
                    skillsDirectory: { minLength: 1, type: "string" },
                    temporaryDirectory: { minLength: 1, type: "string" },
                    workspace: { minLength: 1, type: "string" }
                },
                required: ["ctxId", "expiresAt", "instance", "workspace", "platform", "skillsDirectory", "projectMemoryAgentFile", "projectMemoryDirectory", "temporaryDirectory"],
                type: "object"
            },
            requiredCapabilities: []
        }];
    }
}
