import { resolveToolOutput, type ArtifactImageContent, type ArtifactTransport, type ProcessTransport, type ToolCallRecord, type ToolTransport } from "@portable-devshell/shared";
import { isPresentationBinaryPayload, isPresentationSecretKey, redactPresentationText } from "./Presentation.js";

const ACTIVITY_OUTPUT_PAGE_BYTES = 256 * 1024;
const ACTIVITY_OUTPUT_PAGE_ENTRIES = 32;

export interface McpAppActivityOutput {
    callId: string;
    stdout: string;
    stderr: string;
    nextSeq?: number;
}
export interface McpAppActivity {
    callId: string;
    name: string;
    state: ToolCallRecord["status"];
    at: string;
    exitCode?: number;
    purpose?: string;
    target?: string;
    taskId?: string;
    summary?: string;
    detail?: string;
    /** Bounded, redacted presentation fields; never raw audit records. */
    input?: unknown;
    output?: unknown;
}

function protect(text: string, limit: number): string {
    const masked = redactPresentationText(text);
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
        [key, isPresentationSecretKey(key) ? "[redacted]" :
            isPresentationBinaryPayload(key, entry) ? "[binary payload omitted]" :
                safeValue(entry, depth + 1)]));
}

function presentationValue(value: unknown, maximum: number): unknown {
    let remaining = maximum;
    const visit = (entry: unknown, depth: number): unknown => {
        if (remaining <= 0) return "[presentation limit reached]";
        if (typeof entry === "string") {
            const text = protect(entry, Math.min(remaining, 4_000));
            remaining -= text.length;
            return text;
        }
        if (depth >= 6) return "[nested value]";
        if (Array.isArray(entry)) {
            return [...entry.slice(0, 32).map((item) => visit(item, depth + 1)),
                ...(entry.length > 32 ? [`${entry.length - 32} more entries`] : [])];
        }
        const data = object(entry);
        if (!data) return entry;
        return Object.fromEntries(Object.entries(data).slice(0, 36).map(([key, item]) => {
            remaining -= key.length;
            if (isPresentationSecretKey(key)) return [key, "[redacted]"];
            // Native image payloads never cross the Live audit boundary.
            if (isPresentationBinaryPayload(key, item))
                return [key, "[binary payload omitted]"];
            return [key, visit(item, depth + 1)];
        }));
    };
    return visit(value, 0);
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

function taskId(record: ToolCallRecord): string | undefined {
    if (!record.toolName.startsWith("tmux_")) return undefined;
    const requested = object(record.input)?.task;
    if (typeof requested === "string") return protect(requested, 160);
    const task = object(object(record.output)?.task);
    return typeof task?.id === "string" ? protect(task.id, 160) : undefined;
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
            ...(taskId(record) === undefined ? {} : { taskId: taskId(record) }),
            ...(summary(record) === undefined ? {} : { summary: summary(record) }),
            ...(record.input === undefined ? {} : { input: presentationValue(record.input, 2_000) }),
            ...(record.toolName === "bash_run" ? {
                output: presentationValue({
                    ...(object(record.output) ?? {}),
                    ...(record.stdoutBytes === undefined ? {} : { stdoutBytes: record.stdoutBytes }),
                    ...(record.stderrBytes === undefined ? {} : { stderrBytes: record.stderrBytes }),
                }, 8_000),
            } : record.output === undefined ? {} : { output: presentationValue(record.output, 8_000) }),
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

/** Resolve an image through the authenticated Context's audited ToolCall.
 * The browser supplies callId, never an arbitrary Control imageRef.
 */
export async function readMcpAppActivityImage(
    tools: Pick<ToolTransport, "listCalls">,
    artifacts: Pick<ArtifactTransport, "readImage">,
    ctxId: string,
    callId: string,
): Promise<ArtifactImageContent | undefined> {
    const records = await tools.listCalls({
        ctxId, callIds: [callId], limit: 1, includeInput: false,
        includeOutput: true, maxBytes: 64 * 1024,
    });
    const audited = records.find((entry) =>
        entry.callId === callId && entry.ctxId === ctxId &&
        entry.toolName === "artifact_viewImage" && entry.status === "completed");
    const imageRef = object(audited?.output)?.imageRef;
    if (typeof imageRef !== "string" || !imageRef) return undefined;
    return await artifacts.readImage(imageRef);
}

/** Loads terminal output only for a ToolCall owned by the requesting Context.
 * The ToolCall audit never stores a second copy of the streams.
 */
export async function readMcpAppActivityOutput(
    tools: Pick<ToolTransport, "listCalls">,
    process: Pick<ProcessTransport, "readLogs">,
    ctxId: string,
    callId: string,
    fromSeq = 1,
): Promise<McpAppActivityOutput | undefined> {
    const records = await tools.listCalls({
        ctxId, callIds: [callId], limit: 1, includeInput: false,
        includeOutput: true, maxBytes: 64 * 1024,
    });
    const audited = records.find((entry) =>
        entry.callId === callId && entry.ctxId === ctxId && entry.toolName === "bash_run");
    if (audited === undefined) return undefined;
    const entries = await process.readLogs({
        callId, ctxId, fromSeq, limit: ACTIVITY_OUTPUT_PAGE_ENTRIES,
        maxDecodedBytes: ACTIVITY_OUTPUT_PAGE_BYTES,
    }).then((logs) => logs.filter((entry) => entry.callId === callId && entry.ctxId === ctxId));
    const restored = object(resolveToolOutput(undefined, callId, entries));
    const bytes = entries.reduce((size, entry) => size + Buffer.byteLength(entry.message, "utf8"), 0);
    const last = entries.at(-1);
    const hasMore = last !== undefined &&
        (entries.length >= ACTIVITY_OUTPUT_PAGE_ENTRIES || bytes >= ACTIVITY_OUTPUT_PAGE_BYTES);
    return {
        callId,
        stdout: typeof restored?.stdout === "string"
            ? protect(restored.stdout, ACTIVITY_OUTPUT_PAGE_BYTES + 1024) : "",
        stderr: typeof restored?.stderr === "string"
            ? protect(restored.stderr, ACTIVITY_OUTPUT_PAGE_BYTES + 1024) : "",
        ...(hasMore ? { nextSeq: last.seq + 1 } : {}),
    };
}
