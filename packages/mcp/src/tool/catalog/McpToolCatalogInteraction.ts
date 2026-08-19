import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

import { workspaceAppResourceUri } from "../../workspace/McpWorkspaceApp.js";

export type McpToolCatalogInteractionName =
    | "ask_question"
    | "workspace_open"
    | "workspace_snapshot"
    | "workspace_watch"
    | "workspace_question_answer"
    | "workspace_wait_interrupt"
    | "workspace_task_control"
    | "workspace_wait_recover"
    | "workspace_approval_decide";

const objectOutput: JsonValue = { type: "object" };
const appOnlyMeta: JsonValue = {
    ui: { visibility: ["app"] },
    "openai/visibility": "private",
    "openai/widgetAccessible": true,
};

export class McpToolCatalogInteraction {
    readonly #definitions: readonly ToolDefinition[] = [
        {
            description: "Ask the user one question and wait for their answer without ending the current model turn. The Workspace must already have been opened once with workspace_open for this ctxId. Use this only when progress genuinely requires human input. The taskId must identify the durable task being worked on.",
            group: "interaction",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    allowText: {
                        description: "Whether the user may enter a free-text answer. Defaults to true.",
                        type: "boolean",
                    },
                    choices: {
                        description: "Optional single-choice answers shown to the user.",
                        items: { minLength: 1, type: "string" },
                        maxItems: 12,
                        type: "array",
                    },
                    question: {
                        description: "Question shown to the user.",
                        minLength: 1,
                        type: "string",
                    },
                    taskId: {
                        description: "Stable taskId returned by todo_read or todo_write.",
                        minLength: 1,
                        type: "string",
                    },
                },
                required: ["taskId", "question"],
                type: "object",
            },
            name: "ask_question",
            outputSchema: {
                additionalProperties: false,
                properties: {
                    answer: { type: "string" },
                    questionId: { minLength: 1, type: "string" },
                },
                required: ["questionId", "answer"],
                type: "object",
            },
            requiredCapabilities: [],
        },
        {
            _meta: {
                ui: { resourceUri: workspaceAppResourceUri, visibility: ["model", "app"] },
                "openai/outputTemplate": workspaceAppResourceUri,
            },
            description: "Open the portable-devshell Workspace control surface for the current ctxId. Call once when the user needs persistent visibility or human interaction; ordinary tools do not need to reopen it.",
            group: "interaction",
            inputSchema: { additionalProperties: false, properties: {}, type: "object" },
            name: "workspace_open",
            outputSchema: objectOutput,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description: "Read the authoritative Workspace snapshot for the current ctxId. App-only helper; models should not call it.",
            group: "interaction",
            inputSchema: {
                additionalProperties: false,
                properties: { token: { minLength: 1, type: "string" } },
                type: "object"
            },
            name: "workspace_snapshot",
            outputSchema: objectOutput,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description: "Wait for relevant Workspace state changes after a cursor. App-only helper; models should not call it.",
            group: "interaction",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    cursor: { minimum: 0, type: "integer" },
                    token: { minLength: 1, type: "string" },
                },
                required: ["cursor"],
                type: "object",
            },
            name: "workspace_watch",
            outputSchema: objectOutput,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description: "Answer one pending portable-devshell question. App-only human action; models must not call it.",
            group: "interaction",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    answer: { minLength: 1, type: "string" },
                    token: { minLength: 1, type: "string" },
                    waitId: { minLength: 1, type: "string" },
                },
                required: ["waitId", "answer", "token"],
                type: "object",
            },
            name: "workspace_question_answer",
            outputSchema: objectOutput,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description: "Interrupt one active tmux_wait without stopping the tmux task. The held model tool call returns as interrupted and this wait ends; a later tmux_wait creates a new wait for the still-running task. App-only human action; models must not call it.",
            group: "interaction",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    token: { minLength: 1, type: "string" },
                    waitId: { minLength: 1, type: "string" },
                },
                required: ["waitId", "token"],
                type: "object",
            },
            name: "workspace_wait_interrupt",
            outputSchema: objectOutput,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description: "Pause, resume, or cancel one durable task from the Workspace. This controls model re-entry state only; it does not signal terminal processes. App-only human action; models must not call it.",
            group: "interaction",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    action: { enum: ["pause", "resume", "cancel"], type: "string" },
                    taskId: { minLength: 1, type: "string" },
                    token: { minLength: 1, type: "string" },
                },
                required: ["taskId", "action", "token"],
                type: "object",
            },
            name: "workspace_task_control",
            outputSchema: objectOutput,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description: "Claim one resolved detached wait before the Workspace asks the model to resume. App-only recovery helper; models must not call it.",
            group: "interaction",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    token: { minLength: 1, type: "string" },
                    waitId: { minLength: 1, type: "string" },
                },
                required: ["waitId", "token"],
                type: "object",
            },
            name: "workspace_wait_recover",
            outputSchema: objectOutput,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description: "Approve or deny one pending portable-devshell tool approval. App-only human action; models must not call it.",
            group: "interaction",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    approvalId: { minLength: 1, type: "string" },
                    decision: { enum: ["approve", "deny"], type: "string" },
                    token: { minLength: 1, type: "string" },
                },
                required: ["approvalId", "decision", "token"],
                type: "object",
            },
            name: "workspace_approval_decide",
            outputSchema: objectOutput,
            requiredCapabilities: [],
        },
    ];

    list(): ToolDefinition[] {
        return this.#definitions.map((definition) => ({ ...definition }));
    }
}
