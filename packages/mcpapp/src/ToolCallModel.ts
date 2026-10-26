export interface ToolCallResult {
    name?: string;
    isError: boolean;
    output?: unknown;
    /** Native MCP image content, if the Host provides it; never fetched from a remote URL. */
    image?: { src: string; mediaType: string };
}

export interface ToolCallPresentation {
    name: string;
    input?: unknown;
    result?: ToolCallResult;
    purpose?: string;
    summary?: string;
    detail?: string;
    state?: string;
}

export function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
}

export function string(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? redact(value) : undefined;
}

export function number(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const privateKey = /password|secret|token|credential|authorization|api.?key|private.?key|cookie/iu;
const bearer = /(Bearer\s+)[A-Za-z0-9._~+/-]+/giu;
const assignment = /((?:password|secret|token|credential|authorization|api[_-]?key|private[_-]?key|cookie)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;

export function redact(value: string): string {
    return value
        .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu, "[redacted private key]")
        .replace(bearer, "$1[redacted]")
        .replace(assignment, "$1[redacted]");
}

export function safeValue(value: unknown, depth = 0): unknown {
    if (typeof value === "string") return redact(value).slice(0, 8_000);
    if (depth > 5) return "[nested value]";
    if (Array.isArray(value)) return value.slice(0, 40).map((entry) => safeValue(entry, depth + 1));
    const data = record(value);
    if (!data) return value;
    return Object.fromEntries(Object.entries(data).slice(0, 40).map(([key, entry]) => [
        key, privateKey.test(key) ? "[redacted]" : safeValue(entry, depth + 1),
    ]));
}

export const toolTitles: Record<string, string> = {
    bash_run: "Run command",
    file_read: "Read files",
    file_grep: "Search content",
    file_glob: "Find files",
    file_edit: "Edit files",
    tmux_run: "Run task",
    tmux_read: "Read task output",
    tmux_input: "Send terminal input",
    tmux_inspect: "Inspect terminal",
    tmux_manage: "Manage terminals",
    progress_report: "Progress report",
    environ_info: "Workspace environment",
    environ_remote: "Remote environment",
    artifact_viewImage: "View image",
    mcpapp_open: "Open workspace",
};

export function titleFor(name: string): string {
    return toolTitles[name] ?? name.replaceAll("_", " ");
}

function paths(value: unknown): string[] {
    return Array.isArray(value) ? value.map((item) =>
        string(item) ?? string(record(item)?.path)).filter((item): item is string => !!item) : [];
}

export function headlineFor({ name, input, result, purpose, summary }: ToolCallPresentation): string {
    const args = record(input);
    const output = record(result?.output);
    const label = purpose ?? string(args?.purpose);
    const filePaths = paths(args?.files);
    if (!filePaths.length && Array.isArray(output?.files)) filePaths.push(...paths(output.files));
    if (label) {
        const target = name === "file_read" ? filePaths.join(", ") :
            name === "bash_run" || name === "tmux_run" ? string(args?.command) : undefined;
        return (redact(label) + (target ? " · " + target : "")).slice(0, 250);
    }
    switch (name) {
        case "bash_run": return string(args?.command)?.slice(0, 250) ?? summary ?? "Shell command";
        case "file_read": return filePaths.join(", ") || summary || "File content";
        case "file_grep": return string(args?.pattern) ?? summary ?? "Content search";
        case "file_glob": return paths(args?.patterns).join(", ") || summary || "Path discovery";
        case "file_edit": {
            const operations = output?.operations;
            const total = number(record(output?.editSummary)?.totalOperations);
            return Array.isArray(operations)
                ? (total ?? operations.length) + " file operation" + ((total ?? operations.length) === 1 ? "" : "s")
                : "Apply file changes";
        }
        case "tmux_run": return string(args?.command)?.slice(0, 250) ?? summary ?? "Task started";
        case "tmux_read": return string(args?.task) ?? summary ?? "Task transcript";
        case "tmux_input": return string(args?.task) ?? string(args?.pane) ?? summary ?? "Terminal input";
        case "tmux_inspect": return string(args?.pane) ?? summary ?? "Terminal snapshot";
        case "tmux_manage": return string(args?.command) ?? summary ?? "Terminal resources";
        case "progress_report": return string(args?.message)?.slice(0, 180) ?? summary ?? "Progress update";
        case "artifact_viewImage": return string(output?.name) ?? string(args?.path) ??
            string(args?.handle) ?? summary ?? "Image";
        case "environ_info": return string(output?.workspace) ?? string(args?.workspace) ?? summary ?? "Context ready";
        case "environ_remote": return string(args?.command) ?? string(args?.target) ?? summary ?? "Remote operation";
        case "mcpapp_open": return summary ?? "Workspace opened";
        default:
            return string(args?.command) ?? string(args?.path) ?? string(args?.target) ??
                summary ?? titleFor(name);
    }
}
