import type { ToolCallRecord, ToolTransport } from "@portable-devshell/shared";

export interface McpAppActivity {
    callId: string;
    name: string;
    state: ToolCallRecord["status"];
    at: string;
    exitCode?: number;
    purpose?: string;
    target?: string;
    summary?: string;
    detail?: string;
}

const privateKey = /password|secret|token|credential|authorization|api.?key|private.?key|cookie/iu;
const privateValue = /((?:password|secret|token|credential|authorization|api[_-]?key|private[_-]?key|cookie)\s*[=:]\s*)([^\s,;"']+|"[^"]*"|'[^']*')/giu;
const bearer = /(Bearer\s+)[A-Za-z0-9._~+/-]+/giu;

function protect(text: string, limit: number): string {
    const masked = text
        .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu, "[redacted private key]")
        .replace(bearer, "$1[redacted]")
        .replace(privateValue, "$1[redacted]");
    return masked.length > limit ? `${masked.slice(0, limit)}\n… [truncated]` : masked;
}

function object(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
}

function safeValue(value: unknown, depth = 0): unknown {
    if (typeof value === "string") return protect(value, 4_000);
    if (depth >= 5) return "[nested value]";
    if (Array.isArray(value)) return [...value.slice(0, 12).map((entry) => safeValue(entry, depth + 1)),
        ...(value.length > 12 ? [`… ${value.length - 12} more entries`] : [])];
    const data = object(value);
    if (!data) return value;
    return Object.fromEntries(Object.entries(data).slice(0, 24).map(([key, entry]) =>
        [key, privateKey.test(key) ? "[redacted]" : safeValue(entry, depth + 1)]));
}

function target(record: ToolCallRecord): string | undefined {
    const input = object(record.input);
    if (input) {
        const command = input.command;
        if (typeof command === "string") return protect(command, 400);
        for (const key of ["path", "workspace", "cwd", "pane", "task", "pattern", "target", "handle"]) {
            if (typeof input[key] === "string") return protect(input[key], 400);
        }
        for (const key of ["files", "paths", "patterns"]) {
            const entries = input[key];
            if (!Array.isArray(entries)) continue;
            const paths = entries.map((item) => typeof item === "string" ? item : object(item)?.path)
                .filter((item): item is string => typeof item === "string");
            if (paths.length) return protect(paths.slice(0, 4).join(", "), 400);
        }
    }
    return record.inputSummary ? protect(record.inputSummary, 400) : undefined;
}

function detail(name: string, output: unknown): string | undefined {
    if (output === undefined || output === null) return undefined;
    const result = object(output);
    if (name === "file_read" && Array.isArray(result?.files)) {
        const files = result.files.slice(0, 8).map((item) => {
            const file = object(item);
            if (!file) return "";
            const path = typeof file.path === "string" ? protect(file.path, 300) : "File";
            const content = typeof file.content === "string" ? protect(file.content, 4_000)
                : JSON.stringify(safeValue(file), null, 2);
            return `${path}\n${content}`;
        });
        return protect(files.filter(Boolean).join("\n\n"), 7_000);
    }
    if (result) {
        const text = ["stdout", "stderr", "diff", "patch", "content", "message", "text", "error"]
            .filter((key) => typeof result[key] === "string" && result[key] !== "")
            .map((key) => `${key}:\n${protect(result[key] as string, 4_000)}`);
        if (text.length) return protect(text.join("\n\n"), 7_000);
    }
    const formatted = typeof output === "string" ? protect(output, 7_000)
        : JSON.stringify(safeValue(output), null, 2);
    return formatted ? protect(formatted, 7_000) : undefined;
}

function summary(record: ToolCallRecord): string | undefined {
    const parts: string[] = [];
    if (typeof record.exitCode === "number") parts.push(`exit ${record.exitCode}`);
    if (typeof record.stdoutBytes === "number") parts.push(`${record.stdoutBytes} stdout bytes`);
    if (typeof record.stderrBytes === "number" && record.stderrBytes > 0)
        parts.push(`${record.stderrBytes} stderr bytes`);
    if (record.failureStage) parts.push(record.failureStage);
    if (record.error) parts.push(protect(record.error, 200));
    return parts.length ? parts.join(" · ") : undefined;
}

/** The Instance audit log is authoritative, including its active calls.
 * Only this Context's calls are projected, and no raw audit payload crosses
 * the MCP App Live boundary. Every tool has a generic structured fallback.
 */
export function projectMcpAppActivity(records: readonly ToolCallRecord[], ctxId: string): McpAppActivity[] {
    return records.filter((record) => record.ctxId === ctxId)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 50)
        .map((record) => ({
            callId: record.callId,
            name: record.toolName,
            state: record.status,
            at: record.completedAt ?? record.startedAt,
            ...(typeof record.exitCode === "number" ? { exitCode: record.exitCode } : {}),
            ...(record.purpose ? { purpose: protect(record.purpose, 200) } : {}),
            ...(target(record) === undefined ? {} : { target: target(record) }),
            ...(summary(record) === undefined ? {} : { summary: summary(record) }),
            ...(detail(record.toolName, record.output) === undefined ? {}
                : { detail: detail(record.toolName, record.output) }),
        }));
}

export async function readMcpAppActivity(transport: Pick<ToolTransport, "listCalls">, ctxId: string): Promise<McpAppActivity[]> {
    try {
        return projectMcpAppActivity(await transport.listCalls({
            ctxId, limit: 50, includeInput: true, includeOutput: true, maxBytes: 8 * 1024 * 1024,
        }), ctxId);
    } catch {
        // Large output is not a reason to lose the execution timeline.
        return projectMcpAppActivity(await transport.listCalls({
            ctxId, limit: 50, includeInput: false, includeOutput: false,
        }), ctxId);
    }
}
