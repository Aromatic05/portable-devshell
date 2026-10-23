import type { ToolDefinition } from "@portable-devshell/shared";

/** One Context-owned final objective; work plans live in Agent Memory. */
export function workspaceGoalDefinition(): ToolDefinition {
    return {
        name: "workspace_goal",
        group: "workspace",
        requiredCapabilities: [],
        description: "Manage the current Context's final Goal. start sets one objective; update changes its objective or note; block records a blocker; resume reactivates your blocked Goal, but cannot resume a user-paused Goal; finish explicitly completes the objective. get reads its current state. Store plans, subtasks and checkpoints in the bound Agent Memory, not in Goal.",
        _meta: { devshell: { mcp: {
            title: "Manage final Goal",
            annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
        } } },
        inputSchema: {
            type: "object", additionalProperties: false,
            required: ["action"],
            properties: {
                action: { type: "string", enum: ["get", "start", "update", "block", "resume", "finish"] },
                objective: { type: "string", minLength: 1, maxLength: 4000 },
                note: { type: "string", minLength: 1, maxLength: 2000 },
                expectedGoalId: { type: "string", minLength: 1 },
                expectedRevision: { type: "integer", minimum: 1 },
            },
        },
        outputSchema: {
            type: "object", additionalProperties: false, required: ["goal"],
            properties: { goal: { type: ["object", "null"] } },
        },
    };
}
