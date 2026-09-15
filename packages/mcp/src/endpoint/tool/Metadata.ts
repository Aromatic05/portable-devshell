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

const MCP_WORKER_TOOL_DESCRIPTIONS = new Map<string, string>([
    ["environ_info", "Prepare the current devshell Context and workspace. Call once before other tools; it also bootstraps the Live Workspace. Use workspace to attach or switch, or ctxId to select an existing Context."],
    ["environ_remote", "Manage remote environments for this Context. Use command=help for current operations. Handles come from devshell instance list/status; mask is irreversible for the Context."],
    ["bash_run", "Execute short, bounded, non-interactive shell work. For long-running or PTY-oriented work call tmux_run instead. When retained stdout/stderr paths are returned, file_read can retrieve omitted output."],
    ["file_edit", "Apply an ordered multi-file edit. Existing target content must first be covered by file_read or file_grep; keep related mutations in one change set and inspect any failed operation before retrying."],
    ["file_glob", "Locate files and directories by exact path or glob. Use it for path discovery, not text matching; continue a paged traversal by calling file_glob again with cursor alone."],
    ["file_grep", "Search text across files, directories, or globs. Returned lines establish file_edit coverage. Continue per-file truncation with startLine and traversal pages with cursor alone."],
    ["file_read", "Read file content, structural outline, metadata, or retained tool output. Use selectors to keep large text reads focused; content reads establish file_edit coverage and nextSelector continues truncated content."],
    ["tmux_input", "Send terminal input to a managed task or persistent pane. Use task ids for managed executions and pane ids/names for persistent interactions; observe follow-up output with tmux_read or tmux_inspect as appropriate."],
    ["tmux_inspect", "Inspect pane terminal screen/history without consuming a managed task transcript. Use it for persistent terminals and current TUI/curses screen state; use tmux_read for durable managed-task transcript consumption."],
    ["tmux_manage", "Manage tmux resources with command=list, create, or close. list discovers panes and active tasks, create opens a persistent interactive pane, and close terminates a task or closes a persistent pane; force explicitly permits busy-resource termination."],
    ["tmux_read", "Wait for or consume a managed task's durable transcript. Positive line values consume the oldest unread lines. Negative values also consume all unread transcript data, discard the earlier portion, and return only the requested tail after waiting. Use tmux_inspect instead when non-consuming pane screen state is required."],
    ["tmux_run", "Start long-running or PTY/interactive work as a managed task. Prefer wait=block for work that must complete on the current critical path; use wait=nonblock when continuing other work or planning later interaction through tmux_read/tmux_input."],
    ["todo_read", "Read todo plans. With no selector, list live tasks. Prefer taskId once known; title is compatibility-only. Use todo tools only for multi-step work."],
    ["todo_report", "Send a user-visible message without ending the turn or changing Todo state. Reply to comments first. #push requires a reply within five tool calls. #stop disables tools until #resume. Otherwise report only meaningful new progress; never repeat reports."],
    ["todo_write", "Replace a todo plan completely. Create with revision=0 and immutable title; then reuse taskId and current revision. At most one item is in_progress; blocked/failed require detail. checkpoint stores durable handoff context. Update on state changes."],
    ["workspace_ask", "Ask the user one blocking question in the Live Workspace without ending the model turn. Use only when progress requires human input; Goal/Todo association is inferred."],
    ["workspace_goal", "Manage the durable Workspace Goal. start creates; get reads; update edits; block/resume control continuation; finish completes an all-terminal Goal; stop exits Goal mode without stopping shell/tmux. The final terminal step completes the Goal automatically."],
    ["workspace_open", "Re-present or restore the Live Workspace only when its App is inactive or dismissed. Normal startup is handled by environ_info."]
]);

export class McpToolDescriptionEnhancer {
    enhance(toolName: string, description: string | undefined): string {
        return MCP_WORKER_TOOL_DESCRIPTIONS.get(toolName) ?? description?.trim() ?? "";
    }
}

const titles: Readonly<Record<string, string>> = {
    artifact_share: "Share artifact",
    artifact_viewImage: "View image",
    bash_run: "Run shell command",
    environ_info: "Create environment",
    environ_remote: "Manage remote environment",
    file_edit: "Edit file",
    file_glob: "Glob files",
    file_grep: "Grep files",
    file_read: "Read file",
    instance_create: "Create instance",
    instance_list: "List instances",
    instance_status: "Read instance status",
    instance_stop: "Stop instance",
    tmux_input: "Send tmux input",
    tmux_inspect: "Inspect tmux pane",
    tmux_manage: "Manage tmux resources",
    tmux_read: "Read tmux task",
    tmux_run: "Run tmux task",
    todo_read: "Read task plan",
    todo_report: "Message user",
    todo_write: "Update task plan",
    workspace_ask: "Ask user",
    workspace_approval: "Decide approval",
    workspace_goal: "Manage goal",
    workspace_resume: "Resume goal",
    workspace_stop: "Stop goal",
    workspace_open: "Open Workspace",
    workspace_reconnect: "Reconnect Workspace",
    workspace_answer: "Answer question",
    workspace_snapshot: "Read Workspace snapshot",
    workspace_task: "Control task",
    workspace_interrupt: "Stop waiting",
    workspace_recover: "Dismiss wait resume",
    workspace_watch: "Watch Workspace",
};

export function mcpToolTitle(toolName: string): string {
    return titles[toolName] ?? humanizeToolName(toolName);
}

const invocationStatuses: Readonly<Record<string, { invoked: string; invoking: string }>> = {
    workspace_ask: { invoked: "Answer received", invoking: "Waiting for your answer…" },
    workspace_open: { invoked: "Workspace ready", invoking: "Opening Workspace…" },
};

export function mcpToolInvocationStatus(toolName: string): { invoked: string; invoking: string } | undefined {
    return invocationStatuses[toolName];
}

function humanizeToolName(toolName: string): string {
    const words = toolName
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[_\-\s]+/u)
        .filter(Boolean);
    if (words.length === 0) return toolName;
    const text = words.join(" ").toLowerCase();
    return text[0]!.toUpperCase() + text.slice(1);
}
