import type { CallToolResult } from "@modelcontextprotocol/server";
import type { JsonValue } from "@portable-devshell/shared";

import { McpNativeToolResult, type McpEndpointResult } from "./Boundary.js";

/**
 * Budgets apply only to the MCP model-facing projection, not the executed
 * ToolCall, its outbound hooks, audit record or retained artifacts.
 * Token counts are approximate: 3 UTF-8 bytes per token is deliberately
 * conservative for mixed source code and natural language. A client owns the
 * final model tokenizer and its remaining context window.
 */
export interface McpModelOutputBudget {
    defaultTokens?: number;
    maxTokens?: number;
    byTool?: Readonly<Record<string, number>>;
}

const TOKEN_BYTES = 3;
const MIN_TOKENS = 256;
const HARD_MAX_TOKENS = 24_000;
const DEFAULT_TOKENS = 8_000;
const DEFAULT_TOOL_TOKENS: Readonly<Record<string, number>> = {
    bash_run: 4_000,
    file_read: 6_000,
    file_grep: 4_000,
    file_glob: 2_000,
    file_edit: 2_000,
    tmux_run: 4_000,
    tmux_read: 4_000,
    tmux_input: 4_000,
    tmux_inspect: 4_000,
    tmux_manage: 1_000,
    todo_read: 2_000,
    todo_write: 500,
    todo_report: 500,
    environ_info: 2_000,
    environ_remote: 2_000,
};

type RecordValue = Record<string, JsonValue>;

export function validateMcpModelOutputBudget(policy: McpModelOutputBudget): void {
    const maximum = policy.maxTokens ?? HARD_MAX_TOKENS;
    validateTokens(maximum, "maxTokens", HARD_MAX_TOKENS, 4_000);
    if (policy.defaultTokens !== undefined)
        validateTokens(policy.defaultTokens, "defaultTokens", maximum);
    for (const [name, tokens] of Object.entries(policy.byTool ?? {})) {
        if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u.test(name))
            throw new TypeError(`Invalid MCP model output tool name: ${name}`);
        const minimum = name.startsWith("tmux_") ? 4_000
            : name === "bash_run" || name === "file_glob" ? 2_000 : MIN_TOKENS;
        validateTokens(tokens, `byTool.${name}`, maximum, minimum);
    }
}

function validateTokens(value: number, name: string, maximum: number, minimum = MIN_TOKENS): void {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new TypeError(`MCP model output ${name} must be between ${minimum} and ${maximum} tokens.`);
}

export function projectMcpModelOutput(
    toolName: string,
    original: McpEndpointResult,
    policy: McpModelOutputBudget = {},
): McpEndpointResult {
    // App-only tools exchange UI state and capabilities, not model tool output.
    if (toolName.startsWith("mcpapp_")) return original;
    const maximum = policy.maxTokens ?? HARD_MAX_TOKENS;
    const configured = policy.byTool?.[toolName] ??
        DEFAULT_TOOL_TOKENS[toolName] ?? policy.defaultTokens ?? DEFAULT_TOKENS;
    const budget = Math.min(configured, maximum) * TOKEN_BYTES;
    const native = original instanceof McpNativeToolResult;
    let result = native ? original.structuredContent : original;
    let content: CallToolResult["content"] = native ? original.content : [];
    if (toolName !== "todo_write" && toolName !== "todo_report" &&
        resultBytes(result, content) <= budget)
        return original;

    // The success message is the input the model just sent, not new evidence.
    if (toolName === "todo_report" && isRecord(result) && result.reported === true)
        content = [];
    if (toolName === "todo_write" && isRecord(result))
        result = compactTodoWrite(result);

    if (resultBytes(result, content) > budget) {
        if (toolName === "bash_run" && isRecord(result))
            result = projectBash(result, budget, content);
        else if (toolName === "file_read" && isRecord(result))
            result = projectFileRead(result, budget, content);
        else if (toolName === "file_grep" && isRecord(result))
            result = projectFileGrep(result, budget, content);
        else if (toolName === "file_edit" && isRecord(result))
            result = projectFileEdit(result, budget, content);
        else if (toolName === "todo_read" && isRecord(result))
            result = projectTodoRead(result, budget, content);
    }

    // A presentation's text and structuredContent share the same model budget.
    // Do not duplicate arbitrary extension text if structured data already
    // consumes the budget. Images are intentionally not converted to text.
    if (resultBytes(result, content) > budget) {
        const textEntries = content.filter((item) => item.type === "text");
        if (textEntries.length > 0) {
            const remaining = Math.max(0, budget - jsonBytes(result) - 128);
            const each = Math.floor(remaining / textEntries.length);
            content = content.map((item) => item.type === "text"
                ? { ...item, text: shorten(item.text, each, "head") }
                : item);
        }
    }
    if (resultBytes(result, content) > budget) {
        if (toolName === "file_read" || toolName === "file_grep" || toolName === "todo_read") {
            // Reads have no stateful side effects, so reject an oversized
            // batch rather than emit JSON that violates its output schema.
            throw new RangeError(
                `${toolName} response metadata exceeds the model output budget; request fewer files or narrower ranges.`,
            );
        }
        // tmux_run/read consume transcript offsets, and file_glob advances a
        // paging cursor. Trimming either after execution loses unread data.
        // Unknown extension tools may mutate state and have strict output
        // schemas. In these rare cases prefer an oversized valid response
        // over lying about success or dropping unrecoverable information.
        return original;
    }
    if (!native) return result;
    return new McpNativeToolResult({
        ...(original._meta === undefined ? {} : { _meta: original._meta }),
        content,
        isError: original.isError,
        structuredContent: result,
    });
}

function compactTodoWrite(value: RecordValue): RecordValue {
    if (!Array.isArray(value.items) || typeof value.revision !== "number")
        return value;
    const compact: RecordValue = { revision: value.revision };
    for (const key of ["taskId", "title", "summary", "checkpoint", "comment"]) {
        if (value[key] !== undefined) compact[key] = value[key];
    }
    return compact;
}

function projectBash(value: RecordValue, budget: number, content: CallToolResult["content"]): RecordValue {
    const stdout = typeof value.stdout === "string" ? value.stdout : "";
    const stderr = typeof value.stderr === "string" ? value.stderr : "";
    let capacity = Math.max(0, budget - resultBytes({ ...value, stdout: "", stderr: "" }, content) - 256);
    for (let attempt = 0; attempt < 8; attempt++) {
        const stdoutBytes = Buffer.byteLength(stdout, "utf8");
        const stderrBytes = Buffer.byteLength(stderr, "utf8");
        const stderrShare = Math.min(stderrBytes, Math.floor(capacity * (stderrBytes > 0 ? 0.4 : 0)));
        const stdoutShare = Math.min(stdoutBytes, capacity - stderrShare);
        const result: RecordValue = {
            ...value,
            stdout: shorten(stdout, stdoutShare + Math.max(0, capacity - stderrShare - stdoutShare), "middle"),
            stderr: shorten(stderr, capacity - stdoutShare, "middle"),
        };
        if (result.stdout !== stdout) result.stdoutTruncated = true;
        if (result.stderr !== stderr) result.stderrTruncated = true;
        if (resultBytes(result, content) <= budget) return result;
        capacity = Math.floor(capacity * 0.7);
    }
    return { ...value, stdout: "", stderr: "", stdoutTruncated: !!stdout || value.stdoutTruncated === true,
        stderrTruncated: !!stderr || value.stderrTruncated === true };
}

function projectFileRead(value: RecordValue, budget: number, content: CallToolResult["content"]): RecordValue {
    if (!Array.isArray(value.files)) return value;
    const files = value.files.filter(isRecord);
    let perFile = Math.max(16, Math.floor((budget - 512) / Math.max(1, files.length)));
    for (let attempt = 0; attempt < 12; attempt++) {
        const rendered = files.map((file) => {
            if (typeof file.content !== "string") return file;
            if (file.view === "outline") {
                const preview = shorten(file.content, perFile, "head");
                return preview === file.content ? file : {
                    ...file,
                    content: preview,
                    truncated: true,
                };
            }
            const read = shortenNumberedLines(file.content, perFile, /^\d+:/u);
            if (!read.omitted) return file;
            return {
                ...file,
                content: read.text,
                truncated: true,
                nextSelector: read.nextLine === undefined
                    ? file.nextSelector ?? "1"
                    : continuationSelector(file.content, read.nextLine, file.nextSelector),
            };
        });
        const projected = { ...value, files: rendered };
        if (resultBytes(projected, content) <= budget) return projected;
        perFile = Math.max(0, Math.floor(perFile * 0.65));
    }
    // The original request still contains all file paths; retain the file
    // identities and offer selectors rather than omitting an unseen file.
    return {
        ...value,
        files: files.map((file) => typeof file.content === "string"
            ? {
                ...file,
                content: "",
                truncated: true,
                ...(file.view === "outline" ? {}
                    : { nextSelector: file.nextSelector ?? "1" }),
            }
            : file),
    };
}

function projectFileGrep(value: RecordValue, budget: number, content: CallToolResult["content"]): RecordValue {
    if (!Array.isArray(value.files)) return value;
    const files = value.files.filter(isRecord);
    let perFile = Math.max(16, Math.floor((budget - 512) / Math.max(1, files.length)));
    for (let attempt = 0; attempt < 12; attempt++) {
        const rendered = files.map((file) => {
            if (typeof file.content !== "string") return file;
            const read = shortenNumberedLines(file.content, perFile, /^[ *]\d+:/u);
            if (!read.omitted) return file;
            return {
                ...file,
                content: read.text,
                truncated: true,
                nextLine: read.nextLine ?? 1,
            };
        });
        const projected = { ...value, files: rendered };
        if (resultBytes(projected, content) <= budget) return projected;
        perFile = Math.max(0, Math.floor(perFile * 0.65));
    }
    return { ...value, files: files.map((file) => ({
        ...file,
        content: "",
        truncated: true,
        nextLine: 1,
    })) };
}

function projectFileEdit(value: RecordValue, budget: number, content: CallToolResult["content"]): RecordValue {
    if (!Array.isArray(value.operations)) return value;
    const operations = value.operations.filter(isRecord).map((operation) => ({ ...operation }));
    for (let index = operations.length - 1; index >= 0; index--) {
        if (typeof operations[index]?.diff === "string") {
            delete operations[index].diff;
            operations[index].truncated = true;
        }
    }
    const originalOmitted = typeof value.omittedOperations === "number"
        ? value.omittedOperations : 0;
    let projected: RecordValue = { ...value, operations };
    while (resultBytes(projected, content) > budget && operations.length > 0) {
        operations.pop();
        projected = {
            ...value,
            operations,
            omittedOperations: originalOmitted + value.operations.length - operations.length,
        };
    }
    return projected;
}

function projectTodoRead(
    value: RecordValue,
    budget: number,
    content: CallToolResult["content"],
): RecordValue {
    const field = Array.isArray(value.tasks) ? "tasks" :
        Array.isArray(value.items) ? "items" : undefined;
    if (field === undefined) return value;
    const entries = [...(value[field] as JsonValue[])];
    const offset = typeof value.offset === "number" ? value.offset : 0;
    let projected: RecordValue = { ...value, [field]: entries };

    // The continuation index is based on the first omitted original item,
    // not the Worker/TaskStore page end. The next todo_read therefore resumes
    // without losing any entry even if the Core page was already limited.
    while (resultBytes(projected, content) > budget && entries.length > 1) {
        entries.pop();
        projected = {
            ...value,
            [field]: entries,
            offset,
            nextOffset: offset + entries.length,
            modelOutputTruncated: true,
        };
    }
    if (resultBytes(projected, content) <= budget) return projected;

    // A single TODO item may contain several 4 KiB fields. Preserve its
    // required identity/status but shorten optional prose; the full value
    // remains in TodoStore and can be retrieved with a larger budget.
    for (const limit of [1_024, 256, 64]) {
        const shortened = entries.map((entry) => briefTodoEntry(entry, limit));
        projected = {
            ...projected,
            [field]: shortened,
            modelOutputTruncated: true,
            ...(isRecord(value.checkpoint) ? {
                checkpoint: briefTodoCheckpoint(value.checkpoint, limit),
            } : {}),
        };
        if (resultBytes(projected, content) <= budget) return projected;
    }
    return projected;
}

function briefTodoEntry(value: JsonValue, bytes: number): JsonValue {
    if (!isRecord(value)) return value;
    const result: RecordValue = { ...value };
    for (const field of ["content", "detail", "currentItem", "title"]) {
        if (typeof result[field] === "string")
            result[field] = shorten(result[field], bytes, "head");
    }
    if (isRecord(result.checkpoint))
        result.checkpoint = briefTodoCheckpoint(result.checkpoint, bytes);
    return result;
}

function briefTodoCheckpoint(value: RecordValue, bytes: number): RecordValue {
    const result: RecordValue = { ...value };
    for (const field of ["summary", "next"]) {
        if (typeof result[field] === "string")
            result[field] = shorten(result[field], bytes, "head");
    }
    if (Array.isArray(result.blockers))
        result.blockers = result.blockers.slice(0, 3).map((entry) =>
            typeof entry === "string" ? shorten(entry, bytes, "head") : entry);
    return result;
}

function shortenNumberedLines(
    source: string, budget: number, pattern: RegExp,
): { text: string; omitted: boolean; nextLine?: number } {
    if (Buffer.byteLength(source, "utf8") <= budget) return { text: source, omitted: false };
    const lines = source.split("\n");
    const kept: string[] = [];
    let used = 0;
    let omitted = 0;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        const next = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
        if (used + next > budget) { omitted = index; break; }
        kept.push(line);
        used += next;
    }
    const first = lines.slice(omitted).find((line) => pattern.test(line));
    const nextLine = first === undefined ? undefined : Number.parseInt(first.match(/\d+/u)?.[0] ?? "", 10);
    return {
        text: kept.join("\n"),
        omitted: true,
        ...(nextLine === undefined || !Number.isSafeInteger(nextLine) ? {} : { nextLine }),
    };
}

function continuationSelector(
    content: string,
    nextLine: number,
    existing: JsonValue | undefined,
): string {
    const last = [...content.matchAll(/(?:^|\n)(\d+):/gu)].at(-1)?.[1];
    const lastLine = last === undefined ? nextLine : Number.parseInt(last, 10);
    if (typeof existing !== "string" || lastLine < nextLine) return String(nextLine);
    return `${nextLine}-${lastLine}:raw;next=${existing}`;
}

function shorten(text: string, maxBytes: number, mode: "head" | "middle"): string {
    const data = Buffer.from(text, "utf8");
    if (data.length <= maxBytes) return text;
    const marker = "\n... [MCP model output truncated; read a narrower range or retained artifact] ...\n";
    const mark = Buffer.byteLength(marker, "utf8");
    if (maxBytes <= mark) return utf8Edge(data, Math.max(0, maxBytes), false);
    const left = mode === "middle" ? Math.ceil((maxBytes - mark) / 2) : maxBytes - mark;
    const right = mode === "middle" ? maxBytes - mark - left : 0;
    return utf8Edge(data, left, false) + marker +
        (right === 0 ? "" : utf8Edge(data, right, true));
}

function utf8Edge(data: Buffer, bytes: number, tail: boolean): string {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (let removed = 0; removed <= 4 && removed <= bytes; removed++) {
        const length = bytes - removed;
        const segment = tail
            ? data.subarray(data.length - length)
            : data.subarray(0, length);
        try { return decoder.decode(segment); } catch { /* partial code point */ }
    }
    return "";
}

function isRecord(value: JsonValue): value is RecordValue {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonBytes(value: JsonValue): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function resultBytes(value: JsonValue, content: CallToolResult["content"]): number {
    return jsonBytes(value) + content.reduce((bytes, entry) =>
        bytes + (entry.type === "text" ? Buffer.byteLength(entry.text, "utf8") : 0), 0);
}
