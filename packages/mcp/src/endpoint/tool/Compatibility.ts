import { McpNativeToolResult } from "../call/Boundary.js";

interface McpLegacyToolAlias {
    kind: "alias";
    replacement: string;
}

interface McpLegacyWorkspaceAppV0615 {
    kind: "workspace-app-v0615";
    replacement: string;
}

interface McpLegacyToolTombstone {
    help: string;
    kind: "tombstone";
    removedIn: string;
    replacement?: string;
}

export type McpLegacyToolCompatibility =
    | McpLegacyToolAlias
    | McpLegacyToolTombstone
    | McpLegacyWorkspaceAppV0615;

/**
 * @compat mcp-stale-tool-surface
 * @removeAt 0.7.10
 */
const legacyTools: Readonly<Record<string, McpLegacyToolCompatibility>> = {
    ask_question: {
        kind: "alias",
        replacement: "workspace_ask",
    },
    context_message_read: {
        help: "Queued user Comments are delivered automatically with the next successful ordinary tool result. Do not poll for them.",
        kind: "tombstone",
        removedIn: "0.5.1",
    },
    file_write: {
        help: "Use file_edit with an explicit write operation. The old snapshot/revision write contract is not compatible with file_edit and is not replayed automatically.",
        kind: "tombstone",
        removedIn: "0.4.2",
        replacement: "file_edit",
    },
    artifact_share: {
        help: "Use devshell artifact share, shares, or revoke.",
        kind: "tombstone",
        removedIn: "0.6.17",
    },
    instance_create: {
        help: "Use devshell instance create.",
        kind: "tombstone",
        removedIn: "0.6.17",
    },
    instance_connect: {
        help: "Obtain a handle with devshell instance list/status, then use environ_remote command='attach'.",
        kind: "tombstone",
        removedIn: "0.7.1",
    },
    instance_list: {
        help: "Use devshell instance list.",
        kind: "tombstone",
        removedIn: "0.6.17",
    },
    instance_status: {
        help: "Use devshell instance status <instance>.",
        kind: "tombstone",
        removedIn: "0.6.17",
    },
    instance_stop: {
        help: "Use devshell instance stop <instance>.",
        kind: "tombstone",
        removedIn: "0.6.17",
    },
    instance_start: {
        help: "Obtain a handle with devshell instance list/status, then use environ_remote command='attach'.",
        kind: "tombstone",
        removedIn: "0.7.1",
    },
    workspace_approval_decide: {
        help: "Workspace decisions now use the projected workspace_action contract. Refresh the tool list to use the active App protocol.",
        kind: "tombstone",
        removedIn: "0.7.10",
        replacement: "workspace_action",
    },
    workspace_goal_continue: {
        kind: "workspace-app-v0615",
        replacement: "workspace_reentry",
    },
    workspace_goal_pause: {
        help: "Workspace Goal controls now use the projected workspace_action contract.",
        kind: "tombstone",
        removedIn: "0.7.10",
        replacement: "workspace_action",
    },
    workspace_goal_resume: {
        help: "Workspace Goal controls now use the projected workspace_action contract.",
        kind: "tombstone",
        removedIn: "0.7.10",
        replacement: "workspace_action",
    },
    workspace_goal_stop: {
        help: "Workspace Goal controls now use the projected workspace_action contract.",
        kind: "tombstone",
        removedIn: "0.7.10",
        replacement: "workspace_action",
    },
    workspace_question_answer: {
        help: "Workspace question responses now use the projected workspace_action contract.",
        kind: "tombstone",
        removedIn: "0.7.10",
        replacement: "workspace_action",
    },
    workspace_reentry_control: {
        kind: "workspace-app-v0615",
        replacement: "workspace_reentry",
    },
    workspace_task_control: {
        help: "Workspace task controls now use the projected workspace_action contract.",
        kind: "tombstone",
        removedIn: "0.7.10",
        replacement: "workspace_action",
    },
    workspace_wait_interrupt: {
        help: "Workspace wait controls now use the projected workspace_action contract.",
        kind: "tombstone",
        removedIn: "0.7.10",
        replacement: "workspace_action",
    },
    workspace_wait_recover: {
        help: "Workspace wait controls now use the projected workspace_action contract.",
        kind: "tombstone",
        removedIn: "0.7.10",
        replacement: "workspace_action",
    },
    tmux_capture: {
        help: "Use tmux_inspect for pane history. If you already have a durable task id, tmux_read reads that task instead. The old pane-scoped capture call is not translated automatically.",
        kind: "tombstone",
        removedIn: "0.4.2",
        replacement: "tmux_inspect",
    },
    tmux_reclaim: {
        help: "Task adoption after worker restart is automatic now. Inspect current state with tmux_manage command=list or tmux_inspect instead of reclaiming manually.",
        kind: "tombstone",
        removedIn: "0.4.9",
    },
    tmux_send: {
        help: "Use tmux_input with the current durable task id. The old pane-scoped send call cannot be translated safely because tmux_input is task-scoped.",
        kind: "tombstone",
        removedIn: "0.4.2",
        replacement: "tmux_input",
    },
};

export function resolveMcpLegacyTool(
    toolName: string,
): McpLegacyToolCompatibility | undefined {
    return legacyTools[toolName];
}

export function mcpLegacyToolTombstone(
    toolName: string,
    compatibility: McpLegacyToolTombstone,
): McpNativeToolResult {
    const instruction =
        compatibility.replacement === undefined
            ? compatibility.help
            : `${compatibility.help} Refresh the tool list and use ${compatibility.replacement} when appropriate.`;
    return new McpNativeToolResult({
        content: [
            {
                type: "text",
                text: `Cached tool ${toolName} was removed in portable-devshell ${compatibility.removedIn}. ${instruction}`,
            },
        ],
        structuredContent: {
            staleToolSnapshot: {
                assistantInstruction: instruction,
                help: compatibility.help,
                name: toolName,
                removedIn: compatibility.removedIn,
                ...(compatibility.replacement === undefined
                    ? {}
                    : { replacement: compatibility.replacement }),
            },
        },
    });
}
