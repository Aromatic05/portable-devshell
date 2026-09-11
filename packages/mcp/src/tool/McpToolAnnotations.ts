import type { JsonValue } from "@portable-devshell/shared";

export interface McpToolAnnotations extends Record<string, JsonValue> {
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
    readOnlyHint: boolean;
}

const readOnlyTools = new Set([
    "artifact_viewImage",
    "file_glob",
    "file_grep",
    "file_read",
    "instance_list",
    "instance_status",
    "tmux_inspect",
    "todo_read",
    "workspace_open",
    "workspace_reconnect",
    "workspace_snapshot",
    "workspace_watch",
]);

const nonDestructiveMutationTools = new Set([
    "artifact_share",
    "environ_info",
    "instance_create",
    "tmux_read",
    "todo_report",
    "workspace_ask",
    "workspace_goal",
    "workspace_resume",
    "workspace_stop",
    "workspace_answer",
    "workspace_interrupt",
    "workspace_recover",
]);

const idempotentMutationTools = new Set<string>();

const closedWorldTools = new Set([
    "artifact_viewImage",
    "environ_info",
    "environ_remote",
    "file_edit",
    "file_glob",
    "file_grep",
    "file_read",
    "instance_list",
    "instance_status",
    "tmux_inspect",
    "tmux_manage",
    "tmux_read",
    "todo_read",
    "todo_report",
    "todo_write",
    "workspace_ask",
    "workspace_goal",
    "workspace_resume",
    "workspace_stop",
    "workspace_open",
    "workspace_reconnect",
    "workspace_approval",
    "workspace_answer",
    "workspace_snapshot",
    "workspace_task",
    "workspace_interrupt",
    "workspace_recover",
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
