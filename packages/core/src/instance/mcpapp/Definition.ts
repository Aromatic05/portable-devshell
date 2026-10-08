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
            required: ["itemId", "actionId", "requestId"],
            properties: {
                itemId: { type: "string", minLength: 1, maxLength: 256 },
                actionId: { type: "string", enum: [
                    "approve", "deny", "task-pause", "task-resume", "task-cancel",
                    "goal-pause", "goal-resume", "goal-retry", "goal-stop",
                ] },
                expectedRevision: { type: "integer", minimum: 0 },
                requestId: { type: "string", minLength: 16, maxLength: 128 },
            },
        },
        outputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["status", "itemId", "actionId"],
            properties: {
                status: { enum: ["applied", "stale"], type: "string" },
                itemId: { type: "string" },
                actionId: { type: "string" },
            },
        },
    };
}
