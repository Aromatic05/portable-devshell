const titles: Readonly<Record<string, string>> = {
    artifact_read: "Read artifact",
    artifact_share: "Share artifact",
    artifact_transfer: "Transfer artifact",
    artifact_viewImage: "View image",
    bash_run: "Run shell command",
    environ_info: "Create environment",
    file_edit: "Edit file",
    file_find: "Find files",
    file_info: "Inspect file",
    file_read: "Read file",
    file_search: "Search files",
    instance_connect: "Connect instance",
    instance_create: "Create instance",
    instance_list: "List instances",
    instance_status: "Read instance status",
    instance_stop: "Stop instance",
    tmux_close: "Close tmux pane",
    tmux_create: "Create tmux pane",
    tmux_input: "Send tmux input",
    tmux_inspect: "Inspect tmux pane",
    tmux_list: "List tmux panes",
    tmux_read: "Read tmux task",
    tmux_run: "Run tmux task",
    todo_read: "Read task plan",
    todo_write: "Update task plan",
    workspace_ask: "Ask user",
    workspace_approval_decide: "Decide approval",
    workspace_goal: "Manage goal",
    workspace_goal_continue: "Continue goal",
    workspace_goal_stop: "Stop goal",
    workspace_open: "Open Workspace",
    workspace_question_answer: "Answer question",
    workspace_snapshot: "Read Workspace snapshot",
    workspace_task_control: "Control task",
    workspace_wait_interrupt: "Interrupt wait",
    workspace_wait_recover: "Recover wait",
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
