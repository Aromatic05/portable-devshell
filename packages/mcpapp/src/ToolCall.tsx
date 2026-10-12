import type { ReactNode } from "react";

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
    if (!output || result.name !== "bash_run") return "";
    const text = typeof output.stdout === "string" && output.stdout
        ? output.stdout : typeof output.stderr === "string" ? output.stderr : "";
    return hideCredentials(text).trim().slice(0, 180);
}

export function ToolCallCard({ input, result, enabled, onEnabledChange }: {
    input?: unknown;
    result?: ToolCallResult;
    enabled: boolean;
    onEnabledChange: (enabled: boolean) => void;
}): ReactNode {
    const name = result?.name ?? "ToolCall";
    const argument = argumentSummary(input);
    const purpose = asRecord(input)?.purpose;
    const summary = callSummary(result);
    const excerpt = outputExcerpt(result);
    return <section className="toolcall-card" aria-label="ToolCall result">
        <header className="toolcall-head">
            <div className="toolcall-title">
                <strong>{name}</strong>
                <span data-kind={result?.isError ? "error" : result ? "done" : "running"}>
                    {result?.isError ? "Failed" : result ? "Completed" : "Running"}
                </span>
            </div>
            <label className="toolcall-switch">
                <input type="checkbox" checked={enabled} onChange={(event) => onEnabledChange(event.target.checked)} />
                Show tool calls
            </label>
        </header>
        {enabled && <>
            {typeof purpose === "string" && purpose && <p className="toolcall-purpose">{hideCredentials(purpose).slice(0, 150)}</p>}
            {argument && <p className="toolcall-target">{argument}</p>}
            {summary && <p className="toolcall-result-summary">{summary}</p>}
            {excerpt && <p className="toolcall-output-preview">{excerpt}</p>}
            {result && <details className="toolcall-details">
                <summary>{result.isError ? "Error details" : "Result details"}</summary>
                <pre>{preview(result.output)}</pre>
            </details>}
        </>}
    </section>;
}
