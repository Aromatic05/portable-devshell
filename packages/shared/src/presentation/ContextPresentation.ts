export function workspaceFolderName(workspace: string | undefined): string {
    if (workspace === undefined || workspace.length === 0) return "-";
    const normalized = workspace.replace(/[\\/]+$/u, "");
    if (normalized.length === 0) return workspace;
    return normalized.split(/[\\/]/u).at(-1) || workspace;
}

export function compactContextId(ctxId: string, prefixLength = 12): string {
    return ctxId.length <= prefixLength + 4 ? ctxId : `${ctxId.slice(0, prefixLength)}…`;
}

export function humanConversationTitle(input: {
    ctxId: string;
    workspace?: string;
}, contextPrefixLength = 12): string {
    return input.workspace === undefined || input.workspace.length === 0
        ? compactContextId(input.ctxId, contextPrefixLength)
        : workspaceFolderName(input.workspace);
}

export function formatRelativeTime(value: string, now = Date.now()): string {
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) return "Unknown time";
    const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
    if (seconds < 60) return "just now";
    if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
    return `${Math.floor(seconds / 86_400)}d ago`;
}
