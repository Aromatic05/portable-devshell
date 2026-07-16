import type { ToolDefinition } from "@portable-devshell/shared";

export const mcpEnvironmentToolName = "environ_info" as const;

export class McpToolCatalogEnvironment {
    list(): ToolDefinition[] {
        return [{
            description: "Initialize the session context and return the target environment. Call once at the start of each session and include the returned ctxId in every later tool call. Reuse it until a tool explicitly reports that it has expired, then call environ_info again. If it is lost or rejected as invalid, stop and ask the user for instructions.",
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
                    ctxId: { description: "Session context ID.", minLength: 1, type: "string" },
                    expiresAt: { description: "Context expiration time.", minLength: 1, type: "string" },
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
