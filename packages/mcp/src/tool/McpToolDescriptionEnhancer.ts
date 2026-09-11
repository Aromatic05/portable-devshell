const MCP_WORKER_TOOL_DESCRIPTIONS = new Map<string, string>([
    ["bash_run", "Execute short, bounded, non-interactive shell work. For long-running or PTY-oriented work call tmux_run instead. When retained stdout/stderr paths are returned, file_read can retrieve omitted output."],
    ["file_edit", "Apply an ordered multi-file edit. Existing target content must first be covered by file_read or file_grep; keep related mutations in one change set and inspect any failed operation before retrying."],
    ["file_glob", "Locate files and directories by exact path or glob. Use it for path discovery, not text matching; continue a paged traversal by calling file_glob again with cursor alone."],
    ["file_grep", "Search text across files, directories, or globs. Returned lines establish file_edit coverage. Continue per-file truncation with startLine and traversal pages with cursor alone."],
    ["file_read", "Read file content, structural outline, metadata, or retained tool output. Use selectors to keep large text reads focused; content reads establish file_edit coverage and nextSelector continues truncated content."],
    ["tmux_input", "Send terminal input to a managed task or persistent pane. Use task ids for managed executions and pane ids/names for persistent interactions; observe follow-up output with tmux_read or tmux_inspect as appropriate."],
    ["tmux_inspect", "Inspect pane terminal screen/history without consuming a managed task transcript. Use it for persistent terminals and current TUI/curses screen state; use tmux_read for durable managed-task transcript consumption."],
    ["tmux_manage", "Manage tmux resources with command=list, create, or close. list discovers panes and active tasks, create opens a persistent interactive pane, and close terminates a task or closes a persistent pane; force explicitly permits busy-resource termination."],
    ["tmux_read", "Wait for or consume a managed task's durable transcript. Positive line values consume oldest unread output; negative values wait and return a tail. Use tmux_inspect instead when non-consuming pane screen state is required."],
    ["tmux_run", "Start long-running or PTY/interactive work as a managed task. Prefer wait=block for work that must complete on the current critical path; use wait=nonblock when continuing other work or planning later interaction through tmux_read/tmux_input."]
]);

export class McpToolDescriptionEnhancer {
    enhance(toolName: string, description: string | undefined): string {
        return MCP_WORKER_TOOL_DESCRIPTIONS.get(toolName) ?? description?.trim() ?? "";
    }
}
