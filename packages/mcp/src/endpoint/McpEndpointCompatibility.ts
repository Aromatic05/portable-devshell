import { McpNativeToolResult } from "./McpEndpointResult.js";

interface McpLegacyToolAlias {
    kind: "alias";
    replacement: string;
}

interface McpLegacyToolTombstone {
    help: string;
    kind: "tombstone";
    removedIn: string;
    replacement?: string;
}

export type McpLegacyToolCompatibility = McpLegacyToolAlias | McpLegacyToolTombstone;

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
    instance_start: {
        kind: "alias",
        replacement: "instance_connect",
    },
    tmux_capture: {
        help: "Use tmux_inspect for pane history. If you already have a durable task id, tmux_read reads that task instead. The old pane-scoped capture call is not translated automatically.",
        kind: "tombstone",
        removedIn: "0.4.2",
        replacement: "tmux_inspect",
    },
    tmux_reclaim: {
        help: "Task adoption after worker restart is automatic now. Inspect current state with tmux_list or tmux_inspect instead of reclaiming manually.",
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
