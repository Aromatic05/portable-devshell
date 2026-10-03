export function workspaceFolderName(workspace: string | undefined): string {
    if (workspace === undefined || workspace.length === 0) return "-";
    const normalized = workspace.replace(/[\\/]+$/u, "");
    if (normalized.length === 0) return workspace;
    return normalized.split(/[\\/]/u).at(-1) || workspace;
}