import type { ToolDefinition } from "@portable-devshell/shared";

export type McpToolCatalogContextMessageName = "context_message_read";

export class McpToolCatalogContextMessage {
    list(): ToolDefinition[] {
        return [{
            description: "Read user messages queued for this exact MCP context. A successful read marks returned messages delivered. Call this when the user indicates that guidance was sent from the DevShell TUI.",
            group: "todo",
            inputSchema: {
                additionalProperties: false,
                properties: {},
                type: "object"
            },
            name: "context_message_read",
            outputSchema: {
                additionalProperties: false,
                properties: {
                    messages: {
                        items: {
                            additionalProperties: false,
                            properties: {
                                createdAt: { type: "string" },
                                id: { type: "string" },
                                text: { type: "string" }
                            },
                            required: ["createdAt", "id", "text"],
                            type: "object"
                        },
                        type: "array"
                    }
                },
                required: ["messages"],
                type: "object"
            },
            requiredCapabilities: []
        }];
    }
}
