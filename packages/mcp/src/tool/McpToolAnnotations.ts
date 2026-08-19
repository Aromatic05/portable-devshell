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
    "ask_question",
    "environ_info",
    "instance_connect",
    "tmux_create",
    "tmux_read",
    "tmux_wait",
    "workspace_question_answer",
    "workspace_wait_interrupt",
    "workspace_wait_recover",
]);

const idempotentMutationTools = new Set([
    "instance_connect",
]);

const closedWorldTools = new Set([
    "ask_question",
    "todo_read",
    "todo_write",
    "workspace_open",
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
