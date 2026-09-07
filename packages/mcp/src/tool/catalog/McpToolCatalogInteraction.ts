import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

import { workspaceAppResourceUri } from "../../workspace/McpWorkspaceApp.js";
import {
    todoReadOutputSchema,
    workspaceApprovalRequestOutputSchema,
    workspaceGoalContinuationOutputSchema,
    workspaceGoalResultOutputSchema,
    workspaceOpenOutputSchema,
    workspaceQuestionAnswerOutputSchema,
    workspaceReentryOutputSchema,
    workspaceSnapshotOutputSchema,
    workspaceWaitInterruptOutputSchema,
    workspaceWaitRecoveryOutputSchema,
    workspaceWatchOutputSchema,
} from "../McpToolOutputSchemas.js";

export type McpToolCatalogInteractionName =
    | "workspace_ask"
    | "workspace_goal"
    | "workspace_open"
    | "workspace_reconnect"
    | "workspace_snapshot"
    | "workspace_watch"
    | "workspace_question_answer"
    | "workspace_wait_interrupt"
    | "workspace_task_control"
    | "workspace_wait_recover"
    | "workspace_goal_continue"
    | "workspace_goal_pause"
    | "workspace_goal_resume"
    | "workspace_goal_stop"
    | "workspace_reentry_control"
    | "workspace_approval_decide";

const appOnlyMeta: JsonValue = {
    ui: { visibility: ["app"] },
    "openai/visibility": "private",
    "openai/widgetAccessible": true,
};

const goalStepSchema: JsonValue = {
    additionalProperties: false,
    properties: {
        id: { maxLength: 128, minLength: 1, type: "string" },
        note: { maxLength: 2000, minLength: 1, type: "string" },
        status: { enum: ["pending", "active", "completed", "skipped"], type: "string" },
        text: { maxLength: 2000, minLength: 1, type: "string" },
    },
    required: ["id", "text"],
    type: "object",
};

export class McpToolCatalogInteraction {
    readonly #definitions: readonly ToolDefinition[] = [
        {
            description: "Ask the user one question in the active Live Workspace and wait for their answer without ending the current model turn. environ_info normally bootstraps the Live Workspace for the current Context; use workspace_open only if the App must be re-presented or restored. Use this only when progress genuinely requires human input. Durable Goal or Todo association is inferred automatically when available.",
            group: "workspace",
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
                },
                required: ["question"],
                type: "object",
            },
            name: "workspace_ask",
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
            description: "Manage optional Workspace Goal mode for the current Context. environ_info normally bootstraps the Live Workspace, so action=start does not require a separate workspace_open call while the App remains active. start creates one durable Goal with an objective and ordered steps. update revises the objective, complete step list, or one step. Completing or skipping the final remaining step completes the Goal automatically. block suspends automatic continuation with a reason; resume reactivates it. finish remains a compatibility action for an all-terminal live Goal. stop terminates Goal mode without stopping shell or tmux processes. get reads the current Goal. Use workspace_open only to re-present or restore an inactive App.",
            group: "workspace",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    action: { enum: ["start", "get", "update", "block", "resume", "finish", "stop"], type: "string" },
                    note: { maxLength: 2000, minLength: 1, type: "string" },
                    objective: { maxLength: 4000, minLength: 1, type: "string" },
                    status: { enum: ["pending", "active", "completed", "skipped"], type: "string" },
                    stepId: { maxLength: 128, minLength: 1, type: "string" },
                    steps: { items: goalStepSchema, maxItems: 100, minItems: 1, type: "array" },
                    text: { maxLength: 2000, minLength: 1, type: "string" },
                },
                required: ["action"],
                type: "object",
            },
            name: "workspace_goal",
            outputSchema: workspaceGoalResultOutputSchema,
            requiredCapabilities: [],
        },
        {
            _meta: {
                ui: { resourceUri: workspaceAppResourceUri, visibility: ["model", "app"] },
                "ui/resourceUri": workspaceAppResourceUri,
                "openai/outputTemplate": workspaceAppResourceUri,
                "openai/widgetAccessible": true,
            },
            description: "Explicitly re-present or restore the portable-devshell Live Workspace for the current Context. environ_info normally bootstraps and presents the Workspace in the initial environment call, so models should not call workspace_open during the normal startup path. Keep this compatibility entrypoint for a dismissed, remounted, or otherwise inactive App.",
            group: "workspace",
            inputSchema: { additionalProperties: false, properties: {}, type: "object" },
            name: "workspace_open",
            outputSchema: workspaceOpenOutputSchema,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description: "Compatibility fallback for re-establishing the Workspace App lifecycle when direct Live Workspace transport is unavailable. App-only helper; models should not call it.",
            group: "workspace",
            inputSchema: {
                additionalProperties: false,
                properties: { token: { minLength: 1, type: "string" } },
                required: ["token"],
                type: "object"
            },
            name: "workspace_reconnect",
            outputSchema: workspaceSnapshotOutputSchema,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description: "Compatibility fallback for reading the authoritative Workspace snapshot when direct Live Workspace transport is unavailable. App-only helper; models should not call it.",
            group: "workspace",
            inputSchema: {
                additionalProperties: false,
                properties: { token: { minLength: 1, type: "string" } },
                type: "object"
            },
            name: "workspace_snapshot",
            outputSchema: workspaceSnapshotOutputSchema,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description: "Compatibility fallback for waiting on Workspace state changes when direct Live Workspace transport is unavailable. App-only helper; models should not call it.",
            group: "workspace",
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
            outputSchema: workspaceWatchOutputSchema,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description: "Answer one pending portable-devshell Workspace question. App-only human action; models must not call it.",
            group: "workspace",
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
            outputSchema: workspaceQuestionAnswerOutputSchema,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description: "Stop waiting for one tmux_run wait=block without stopping the tmux task. While the original tool call is still blocked it returns immediately to the model; after Workspace handoff the App resumes the model immediately. App-only human action; models must not call it.",
            group: "workspace",
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
            outputSchema: workspaceWaitInterruptOutputSchema,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description: "Pause, resume, or cancel one durable task from the Workspace. This controls model re-entry state only; it does not signal terminal processes. App-only human action; models must not call it.",
            group: "workspace",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    action: { enum: ["pause", "resume", "cancel"], type: "string" },
                    revision: { minimum: 1, type: "integer" },
                    taskId: { minLength: 1, type: "string" },
                    token: { minLength: 1, type: "string" },
                },
                required: ["taskId", "revision", "action", "token"],
                type: "object",
            },
            name: "workspace_task_control",
            outputSchema: todoReadOutputSchema,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description: "Manage one detached-wait model re-entry with durable delivery fencing: claim, mark the outbound attempt before host dispatch, atomically complete an accepted send, safely release before dispatch, reject a definitively rejected send, or explicitly dismiss an uncertain delivery after human reconciliation. App-only recovery helper; models must not call it.",
            group: "workspace",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    action: { enum: ["claim", "attempt", "complete", "release", "reject", "dismiss"], type: "string" },
                    claimId: { minLength: 1, type: "string" },
                    recoveryMessageId: { minLength: 1, type: "string" },
                    token: { minLength: 1, type: "string" },
                    waitId: { minLength: 1, type: "string" },
                },
                required: ["action", "waitId", "token"],
                type: "object",
            },
            name: "workspace_wait_recover",
            outputSchema: workspaceWaitRecoveryOutputSchema,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description: "Manage automatic and user-initiated Workspace Goal continuation with one durable delivery fence. App-only helper; models must not call it.",
            group: "workspace",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    accepted: { type: "boolean" },
                    action: { enum: ["claim", "validate", "attempt", "report", "reset"], type: "string" },
                    available: { type: "boolean" },
                    claimId: { maxLength: 128, minLength: 1, type: "string" },
                    error: { maxLength: 2000, minLength: 1, type: "string" },
                    goalId: { minLength: 1, type: "string" },
                    token: { minLength: 1, type: "string" },
                    userInitiated: { type: "boolean" },
                },
                required: ["action", "token"],
                type: "object",
            },
            name: "workspace_goal_continue",
            outputSchema: workspaceGoalContinuationOutputSchema,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description: "Arbitrate one Context-wide automatic model re-entry across Goal continuation and detached-wait recovery. App-only helper; models must not call it.",
            group: "workspace",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    action: { enum: ["get", "yield", "resume", "claim", "validate", "release"], type: "string" },
                    claimId: { maxLength: 128, minLength: 1, type: "string" },
                    reason: { maxLength: 2000, minLength: 1, type: "string" },
                    token: { minLength: 1, type: "string" },
                },
                required: ["action", "token"],
                type: "object",
            },
            name: "workspace_reentry_control",
            outputSchema: workspaceReentryOutputSchema,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description: "Pause the current active Workspace Goal from the Workspace UI without stopping shell or tmux processes. App-only human action; models must not call it.",
            group: "workspace",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    goalId: { minLength: 1, type: "string" },
                    revision: { minimum: 1, type: "integer" },
                    token: { minLength: 1, type: "string" },
                },
                required: ["goalId", "revision", "token"],
                type: "object",
            },
            name: "workspace_goal_pause",
            outputSchema: workspaceGoalResultOutputSchema,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description: "Resume the current blocked or paused Workspace Goal from the Workspace UI. App-only human action; models must not call it.",
            group: "workspace",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    goalId: { minLength: 1, type: "string" },
                    revision: { minimum: 1, type: "integer" },
                    token: { minLength: 1, type: "string" },
                },
                required: ["goalId", "revision", "token"],
                type: "object",
            },
            name: "workspace_goal_resume",
            outputSchema: workspaceGoalResultOutputSchema,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description: "Stop the current Workspace Goal from the Workspace UI. This ends Goal continuation but does not signal shell or tmux processes. App-only human action; models must not call it.",
            group: "workspace",
            inputSchema: {
                additionalProperties: false,
                properties: {
                    goalId: { minLength: 1, type: "string" },
                    revision: { minimum: 1, type: "integer" },
                    token: { minLength: 1, type: "string" },
                },
                required: ["goalId", "revision", "token"],
                type: "object",
            },
            name: "workspace_goal_stop",
            outputSchema: workspaceGoalResultOutputSchema,
            requiredCapabilities: [],
        },
        {
            _meta: appOnlyMeta,
            description: "Approve or deny one pending portable-devshell tool approval. App-only human action; models must not call it.",
            group: "workspace",
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
            outputSchema: workspaceApprovalRequestOutputSchema,
            requiredCapabilities: [],
        },
    ];

    list(): ToolDefinition[] {
        return this.#definitions.map((definition) => ({ ...definition }));
    }
}
