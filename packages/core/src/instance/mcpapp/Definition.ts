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
                    "question-answer-text", "question-answer-choice",
                ] },
                expectedRevision: { type: "integer", minimum: 0 },
                requestId: { type: "string", minLength: 16, maxLength: 128 },
                input: { type: "string", minLength: 1, maxLength: 4000 },
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
                input: { type: "string" },
                detached: { type: "boolean" },
                question: { type: "string" },
                answer: { type: "string" },
            },
        },
    };
}

export function mcpAppReentryDefinition(): ToolDefinition {
    return {
        name: "mcpapp_reentry",
        group: "mcpapp",
        requiredCapabilities: [],
        description: "Advance an authorized Instance-owned Goal or Todo recovery for Host delivery.",
        _meta: {
            ui: { visibility: ["app"] },
            devshell: { mcp: { title: "Workspace recovery", annotations: {
                destructiveHint: false, idempotentHint: false,
                openWorldHint: false, readOnlyHint: false,
            } } },
        },
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["action", "claimId"],
            properties: {
                action: { type: "string", enum: ["claim", "validate", "attempt", "report", "release"] },
                claimId: { type: "string", minLength: 1, maxLength: 128 },
                sourceId: { type: "string", minLength: 1, maxLength: 256 },
                directiveId: { type: "string", minLength: 1, maxLength: 128 },
                intent: { type: "string", enum: ["automatic", "goal-resume", "goal-retry", "task-resume"] },
                outcome: { type: "string", enum: ["accepted", "rejected", "uncertain"] },
            },
        },
        outputSchema: { type: "object" },
    };
}

export function mcpAppOpenDefinition(): ToolDefinition {
    return {
        name: "mcpapp_open", group: "mcpapp", requiredCapabilities: [],
        description: "Explicitly present the DevShell MCP App in this conversation when the workspace panel is missing or was dismissed. It reuses the current Context; do not call environ_info again just to reopen the App.",
        _meta: { devshell: { mcp: { title: "Open workspace", annotations: {
            destructiveHint: false, idempotentHint: true, readOnlyHint: true, openWorldHint: false,
        } } } },
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        outputSchema: { type: "object", additionalProperties: false, required: ["status"],
            properties: { status: { type: "string", const: "ready" },
                ctxId: { type: "string", minLength: 1 } } },
    };
}

export function mcpAppAskDefinition(): ToolDefinition {
    return {
        name: "mcpapp_ask", group: "mcpapp", requiredCapabilities: [],
        description: "Ask the user a question in the live MCP App and wait for their reply in this tool call. Use only when a human answer is required. First call mcpapp_open if the MCP App is not visible; cancelled calls leave the question available for later answering.",
        _meta: { devshell: { mcp: { title: "Ask user", annotations: {
            destructiveHint: false, idempotentHint: false, readOnlyHint: false, openWorldHint: false,
        } } } },
        inputSchema: { type: "object", additionalProperties: false, required: ["question"],
            properties: {
                question: { type: "string", minLength: 1, maxLength: 4000 },
                choices: { type: "array", items: { type: "string", minLength: 1, maxLength: 256 }, maxItems: 12 },
                allowText: { type: "boolean" },
            } },
        outputSchema: { type: "object", required: ["status"], additionalProperties: false,
            properties: {
                status: { type: "string", enum: ["ready", "answered"] },
                question: { type: "string" },
                choices: { type: "array", items: { type: "string" } },
                allowText: { type: "boolean" },
                questionId: { type: "string" },
                answer: { type: "string" },
            } },
    };
}
