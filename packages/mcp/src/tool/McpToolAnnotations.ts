import type { JsonValue } from "@portable-devshell/shared";

export interface McpToolAnnotations extends Record<string, JsonValue> {
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
    readOnlyHint: boolean;
}

const readOnlyTools = new Set([
    "artifact_read",
    "artifact_viewImage",
    "file_find",
    "file_info",
    "file_read",
    "file_search",
    "instance_list",
    "instance_status",
    "tmux_inspect",
    "tmux_list",
    "todo_read",
    "workspace_open",
    "workspace_snapshot",
    "workspace_watch",
]);

const nonDestructiveMutationTools = new Set([
    "artifact_share",
    "environ_info",
    "instance_connect",
    "instance_create",
    "tmux_create",
    "tmux_read",
    "workspace_ask",
    "workspace_goal",
    "workspace_goal_continue",
    "workspace_goal_stop",
    "workspace_question_answer",
    "workspace_wait_interrupt",
    "workspace_wait_recover",
]);

const idempotentMutationTools = new Set([
    "instance_connect",
]);

const closedWorldTools = new Set([
    "artifact_read",
    "artifact_transfer",
    "artifact_viewImage",
    "environ_info",
    "file_edit",
    "file_find",
    "file_info",
    "file_read",
    "file_search",
    "instance_list",
    "instance_status",
    "tmux_close",
    "tmux_create",
    "tmux_inspect",
    "tmux_list",
    "tmux_read",
    "todo_read",
    "todo_write",
    "workspace_ask",
    "workspace_goal",
    "workspace_goal_continue",
    "workspace_goal_stop",
    "workspace_open",
    "workspace_approval_decide",
    "workspace_question_answer",
    "workspace_snapshot",
    "workspace_task_control",
    "workspace_wait_interrupt",
    "workspace_wait_recover",
    "workspace_watch",
]);

export function mcpToolAnnotations(toolName: string): McpToolAnnotations {
    const readOnlyHint = readOnlyTools.has(toolName);
    return {
        readOnlyHint,
        destructiveHint: !readOnlyHint && !nonDestructiveMutationTools.has(toolName),
        idempotentHint: readOnlyHint || idempotentMutationTools.has(toolName),
        openWorldHint: !closedWorldTools.has(toolName),
    };
}
