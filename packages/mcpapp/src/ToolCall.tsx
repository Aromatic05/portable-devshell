import { useState, type ReactNode } from "react";

export interface ToolCallResult {
    name?: string;
    isError: boolean;
    output?: unknown;
}

export function readToolCallResult(raw: unknown): ToolCallResult | undefined {
    const result = asRecord(raw);
    if (!result) return undefined;
    const meta = asRecord(result._meta);
    const identity = asRecord(meta?.["portable-devshell/toolcall"]);
    if (!("structuredContent" in result) && !("content" in result) && !identity)
        return undefined;
    const output = result.structuredContent ?? result.content;
    return {
        ...(typeof identity?.name === "string" ? { name: identity.name } : {}),
        isError: result.isError === true,
        ...(output === undefined ? {} : { output }),
    };
}

/** Host global restoration is optional and never persisted in widget state. */
export function restoreToolCallResult(): ToolCallResult | undefined {
    const openai = asRecord((window as Window & { openai?: unknown }).openai);
    const metadata = asRecord(openai?.toolResponseMetadata);
    const nested = asRecord(metadata?.mcp_tool_result)
        ?? asRecord(metadata?.call_tool_result);
    if (nested) return readToolCallResult({
        ...nested,
        ...(openai && "toolOutput" in openai ? { structuredContent: openai.toolOutput } : {}),
    });
    if (metadata && ("portable-devshell/toolcall" in metadata || (openai && "toolOutput" in openai)))
        return readToolCallResult({
            _meta: metadata,
            ...(openai && "toolOutput" in openai ? { structuredContent: openai.toolOutput } : {}),
        });
    return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
}

const sensitive = /password|secret|token|credential|authorization|api.?key|private.?key/iu;

function hideCredentials(value: string): string {
    return value
        .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/giu, "$1[redacted]")
        .replace(/(password|token|api[_-]?key)(\s*[:=]\s*)[^\s"',;]+/giu, "$1$2[redacted]");
}

function safePreview(value: unknown, depth = 0): unknown {
    if (typeof value === "string") {
        const text = hideCredentials(value);
        return text.length > 3000 ? text.slice(0, 3000) + "… [truncated]" : text;
    }
    if (depth >= 5) return "[nested value]";
    if (Array.isArray(value)) {
        return [...value.slice(0, 12).map((item) => safePreview(item, depth + 1)),
            ...(value.length > 12 ? [`… ${value.length - 12} more entries`] : [])];
    }
    const record = asRecord(value);
    if (!record) return value;
    const entries = Object.entries(record);
    const visible = entries.slice(0, 24).map(([key, item]) =>
        [key, sensitive.test(key) ? "[redacted]" : safePreview(item, depth + 1)] as const);
    return Object.fromEntries([...visible,
        ...(entries.length > 24 ? [["…", `${entries.length - 24} more fields`] as const] : [])]);
}

function preview(value: unknown): string {
    try {
        const formatted = JSON.stringify(safePreview(value), null, 2);
        const text = formatted ?? "No structured result";
        return text.length > 8000 ? text.slice(0, 8000) + "\n… [truncated]" : text;
    } catch {
        return "Result is not available for display.";
    }
}

/** Format known DevShell results as text, with a bounded generic fallback. */
function formattedOutput(name: string, value: unknown): string {
    const output = asRecord(value);
    if (!output) return typeof value === "string" ? String(safePreview(value)) : preview(value);
    if ((name === "file_read" || name === "file_grep") && Array.isArray(output.files)) {
        const files = output.files.slice(0, 10).map((entry) => {
            const file = asRecord(entry);
            if (!file) return "";
            const path = typeof file.path === "string" ? hideCredentials(file.path) : "File";
            const body = typeof file.content === "string" ? String(safePreview(file.content)) : preview(file);
            return `${path}\n${body}`;
        }).filter(Boolean);
        if (files.length) return files.join("\n\n").slice(0, 8_000);
    }
    const textKeys = ["stdout", "stderr", "diff", "patch", "content", "message", "text", "error"]
        .filter((key) => typeof output[key] === "string" && output[key] !== "");
    if (textKeys.length) {
        const fields = textKeys.map((key) => `${key}:\n${String(safePreview(output[key]))}`);
        const other = Object.fromEntries(Object.entries(output)
            .filter(([key]) => !textKeys.includes(key)));
        if (Object.keys(other).length) fields.push(`Other fields:\n${preview(other)}`);
        return fields.join("\n\n").slice(0, 8_000);
    }
    return preview(value);
}

function argumentSummary(input: unknown): string {
    const args = asRecord(input);
    if (!args) return "";
    const command = args.command;
    const path = args.path ?? args.workspace ?? args.directory ?? args.target;
    if (typeof command === "string") return hideCredentials(command).slice(0, 260);
    if (typeof path === "string") return hideCredentials(path).slice(0, 260);
    const paths = args.paths;
    if (Array.isArray(paths)) {
        const names = paths.map((item) => typeof item === "string" ? item : asRecord(item)?.path)
            .filter((item): item is string => typeof item === "string");
        if (names.length) return names.slice(0, 3).join(", ");
    }
    const files = args.files;
    if (Array.isArray(files)) {
        const names = files.map((item) => asRecord(item)?.path)
            .filter((item): item is string => typeof item === "string");
        if (names.length) return names.slice(0, 3).join(", ");
    }
    if (typeof args.pattern === "string") return args.pattern.slice(0, 220);
    return "";
}

function callSummary(result: ToolCallResult | undefined): string {
    if (!result) return "";
    const output = asRecord(result.output);
    if (!output) return "";
    const parts: string[] = [];
    if (typeof output.exitCode === "number") parts.push(`exit ${output.exitCode}`);
    if (typeof output.durationMs === "number") parts.push(`${Math.round(output.durationMs)} ms`);
    if (typeof output.stdoutBytes === "number") parts.push(`${output.stdoutBytes} stdout bytes`);
    return parts.join(" · ");
}

function outputExcerpt(result: ToolCallResult | undefined): string {
    if (!result) return "";
    const output = asRecord(result.output);
    if (!output) return "";
    if (Array.isArray(output.files) && output.files.length) {
        const file = asRecord(output.files[0]);
        const content = file?.content;
        const path = typeof file?.path === "string" ? file.path : "";
        if (typeof content === "string") return hideCredentials(`${path}\n${content}`).trim().slice(0, 300);
        return `${output.files.length} file${output.files.length === 1 ? "" : "s"}`;
    }
    for (const key of ["stdout", "stderr", "diff", "patch", "content", "message", "text", "error"]) {
        if (typeof output[key] === "string" && output[key])
            return hideCredentials(output[key]).trim().slice(0, 300);
    }
    return typeof output.status === "string" ? output.status : "";
}

export function ToolCallCard({ input, result, enabled, onEnabledChange }: {
    input?: unknown;
    result?: ToolCallResult;
    enabled: boolean;
    onEnabledChange: (enabled: boolean) => void;
}): ReactNode {
    const [expanded, setExpanded] = useState(false);
    const name = result?.name ?? "ToolCall";
    const argument = argumentSummary(input);
    const purpose = asRecord(input)?.purpose;
    const summary = callSummary(result);
    const excerpt = expanded ? outputExcerpt(result) : "";
    const label = typeof purpose === "string" && purpose ? hideCredentials(purpose).slice(0, 150) : "";
    const headline = [label, argument].filter(Boolean).join(" · ") ||
        (result ? outputExcerpt(result).replace(/\s+/gu, " ") : "Waiting for tool result") || name;
    if (!enabled) return <div className="toolcall-hidden">
        <span>ToolCall hidden</span>
        <button type="button" onClick={() => onEnabledChange(true)}>Show</button>
    </div>;
    return <section className="toolcall-card" aria-label="ToolCall result" data-expanded={expanded}>
        <button type="button" className="toolcall-compact" aria-expanded={expanded}
            onClick={() => setExpanded((previous) => !previous)}>
            <span className="toolcall-line">
                <strong>{name}</strong>
                <span data-kind={result?.isError ? "error" : result ? "done" : "running"}>
                    {result?.isError ? "Failed" : result ? "Completed" : "Running"}
                </span>
                {typeof asRecord(result?.output)?.durationMs === "number" &&
                    <span className="toolcall-duration">{Math.round(asRecord(result?.output)!.durationMs as number)}ms</span>}
                <span className="toolcall-chevron" aria-hidden="true">⌄</span>
            </span>
            <span className="toolcall-description" title={headline}>{headline}</span>
        </button>
        {expanded && <div className="toolcall-expanded">
            {label && <p className="toolcall-purpose">{label}</p>}
            {argument && <p className="toolcall-target">{argument}</p>}
            {summary && <p className="toolcall-result-summary">{summary}</p>}
            {excerpt && <p className="toolcall-output-preview">{excerpt}</p>}
            {result && <pre className="toolcall-result-text">{formattedOutput(name, result.output)}</pre>}
        </div>}
    </section>;
}
