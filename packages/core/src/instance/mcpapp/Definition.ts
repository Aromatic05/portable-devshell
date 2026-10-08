import type { ToolDefinition } from "@portable-devshell/shared";

export function mcpAppActionDefinition(): ToolDefinition {
    return {
        name: "mcpapp_action",
        group: "mcpapp",
        requiredCapabilities: [],
        description: "Apply a user-selected workspace action via the Instance ToolCall pipeline.",
        _meta: {
            ui: { visibility: ["app"] },
            devshell: { mcp: { title: "Workspace action", annotations: {
                destructiveHint: true, idempotentHint: false,
                openWorldHint: false, readOnlyHint: false,
            } } },
        },
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["itemId", "actionId"],
            properties: {
                itemId: { type: "string", minLength: 1, maxLength: 256 },
                actionId: { type: "string", enum: [
                    "approve", "deny", "task-pause", "task-resume", "task-cancel",
                    "goal-pause", "goal-resume", "goal-retry", "goal-stop",
                ] },
                expectedRevision: { type: "integer", minimum: 0 },
            },
        },
        outputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["status", "itemId", "actionId"],
            properties: {
                status: { const: "applied", type: "string" },
                itemId: { type: "string" },
                actionId: { type: "string" },
            },
        },
    };
}
