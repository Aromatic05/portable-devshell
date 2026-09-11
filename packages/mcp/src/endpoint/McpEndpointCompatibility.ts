import type { JsonValue } from "@portable-devshell/shared";

import { McpNativeToolResult } from "./McpEndpointResult.js";

interface McpLegacyToolAlias {
    kind: "alias";
    replacement: string;
}

interface McpLegacyWorkspaceAppV0615 {
    kind: "workspace-app-v0615";
    replacement: string;
}

interface McpLegacyFileToolAlias {
    kind: "file-v07-alias";
    removeIn: "0.7.4";
    replacement: "file_glob" | "file_grep" | "file_read";
}

interface McpLegacyTmuxToolAlias {
    command: "list" | "create" | "close";
    kind: "tmux-v07-alias";
    removeIn: "0.7.4";
    replacement: "tmux_manage";
}

interface McpLegacyToolTombstone {
    help: string;
    kind: "tombstone";
    removedIn: string;
    replacement?: string;
}

export type McpLegacyToolCompatibility =
    | McpLegacyToolAlias
    | McpLegacyFileToolAlias
    | McpLegacyTmuxToolAlias
    | McpLegacyToolTombstone
    | McpLegacyWorkspaceAppV0615;

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
    file_find: {
        kind: "file-v07-alias",
        removeIn: "0.7.4",
        replacement: "file_glob",
    },
    file_info: {
        kind: "file-v07-alias",
        removeIn: "0.7.4",
        replacement: "file_read",
    },
    file_search: {
        kind: "file-v07-alias",
        removeIn: "0.7.4",
        replacement: "file_grep",
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
        kind: "alias",
        replacement: "workspace_approval",
    },
    workspace_goal_continue: {
        kind: "workspace-app-v0615",
        replacement: "workspace_reentry",
    },
    workspace_goal_pause: {
        kind: "alias",
        replacement: "workspace_pause",
    },
    workspace_goal_resume: {
        kind: "alias",
        replacement: "workspace_resume",
    },
    workspace_goal_stop: {
        kind: "alias",
        replacement: "workspace_stop",
    },
    workspace_question_answer: {
        kind: "alias",
        replacement: "workspace_answer",
    },
    workspace_reentry_control: {
        kind: "workspace-app-v0615",
        replacement: "workspace_reentry",
    },
    workspace_task_control: {
        kind: "alias",
        replacement: "workspace_task",
    },
    workspace_wait_interrupt: {
        kind: "alias",
        replacement: "workspace_interrupt",
    },
    workspace_wait_recover: {
        kind: "workspace-app-v0615",
        replacement: "workspace_recover",
    },
    tmux_list: {
        command: "list",
        kind: "tmux-v07-alias",
        removeIn: "0.7.4",
        replacement: "tmux_manage",
    },
    tmux_create: {
        command: "create",
        kind: "tmux-v07-alias",
        removeIn: "0.7.4",
        replacement: "tmux_manage",
    },
    tmux_close: {
        command: "close",
        kind: "tmux-v07-alias",
        removeIn: "0.7.4",
        replacement: "tmux_manage",
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

export function resolveMcpLegacyTool(toolName: string): McpLegacyToolCompatibility | undefined {
    return legacyTools[toolName];
}

export function adaptMcpLegacyFileToolInput(toolName: string, input: JsonValue): JsonValue {
    if (toolName !== "file_find" && toolName !== "file_info") return input;
    const record = asRecord(input);
    if (record === undefined) return input;
    if (toolName === "file_find") {
        const { paths, ...rest } = record;
        return {
            ...rest,
            ...(paths === undefined ? {} : { patterns: paths }),
        };
    }
    const { details: _details, paths, ...rest } = record;
    return {
        ...rest,
        files: Array.isArray(paths)
            ? paths.map((path) => ({ path, view: "metadata" }))
            : paths,
    };
}

export function adaptMcpLegacyTmuxToolInput(
    compatibility: McpLegacyTmuxToolAlias,
    input: JsonValue
): JsonValue {
    const record = asRecord(input);
    if (record === undefined) return input;
    return { ...record, command: compatibility.command };
}

export function adaptMcpLegacyFileToolResult(
    toolName: string,
    result: JsonValue,
    originalInput?: JsonValue
): JsonValue {
    if (toolName !== "file_info") return result;
    const record = asRecord(result);
    if (record === undefined || !Array.isArray(record.files)) return result;
    const includeDetails = asRecord(originalInput)?.details === true;
    const entries = record.files.map((value) => {
        const file = asRecord(value);
        const metadata = asRecord(file?.metadata);
        if (file === undefined || metadata === undefined) return value;
        return {
            path: file.path,
            ...(metadata.exists === false ? { exists: false } : {}),
            ...(metadata.type === undefined ? {} : { type: metadata.type }),
            ...(!includeDetails || metadata.sizeBytes === undefined ? {} : { sizeBytes: metadata.sizeBytes }),
            ...(!includeDetails || metadata.modifiedAtMs === undefined ? {} : { modifiedAtMs: metadata.modifiedAtMs }),
            ...(!includeDetails || metadata.mode === undefined ? {} : { mode: metadata.mode }),
            ...(metadata.targetType === undefined ? {} : { targetType: metadata.targetType }),
        };
    });
    const { files: _files, ...rest } = record;
    return { ...rest, entries };
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}

export function mcpLegacyToolTombstone(
    toolName: string,
    compatibility: McpLegacyToolTombstone
): McpNativeToolResult {
    const instruction = compatibility.replacement === undefined
        ? compatibility.help
        : `${compatibility.help} Refresh the tool list and use ${compatibility.replacement} when appropriate.`;
    return new McpNativeToolResult({
        content: [{
            type: "text",
            text: `Cached tool ${toolName} was removed in portable-devshell ${compatibility.removedIn}. ${instruction}`
        }],
        structuredContent: {
            staleToolSnapshot: {
                assistantInstruction: instruction,
                help: compatibility.help,
                name: toolName,
                removedIn: compatibility.removedIn,
                ...(compatibility.replacement === undefined ? {} : { replacement: compatibility.replacement }),
            }
        }
    });
}
