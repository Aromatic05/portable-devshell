import { Text, type Component } from "@earendil-works/pi-tui";

import type { JsonValue } from "@portable-devshell/shared";

import {
    formatFileEditStaticCall,
    renderFileEditCallComponent,
    renderFileEditFallback,
    renderFileEditResultComponent
} from "./file-edit-renderer.js";

export { parseEditChangeSet, renderWorkerUnifiedDiff } from "./file-edit-renderer.js";

export interface PiThemeLike {
    bg(role: string, text: string): string;
    bold(text: string): string;
    fg(role: string, text: string): string;
    inverse(text: string): string;
}

export interface PiToolRenderContextLike {
    args: unknown;
    argsComplete: boolean;
    cwd: string;
    executionStarted: boolean;
    expanded: boolean;
    invalidate(): void;
    isError: boolean;
    isPartial: boolean;
    lastComponent?: Component;
    showImages: boolean;
    state: Record<string, unknown>;
    toolCallId: string;
}

export interface PiToolRenderResultOptionsLike {
    expanded: boolean;
    isPartial: boolean;
}

export interface PiToolRenderResultLike {
    content: Array<{ text?: string; type: string }>;
    details?: JsonValue;
}

const collapsedLineLimit = 18;
const expandedLineLimit = 120;

export function renderPiToolCall(
    toolName: string,
    args: unknown,
    theme: PiThemeLike,
    context: PiToolRenderContextLike
): Component {
    if (toolName === "file_edit") return renderFileEditCallComponent(args, theme, context);
    return setText(context.lastComponent, formatPiToolCall(toolName, args, theme));
}

export function renderPiToolResult(
    toolName: string,
    result: PiToolRenderResultLike,
    options: PiToolRenderResultOptionsLike,
    theme: PiThemeLike,
    context: PiToolRenderContextLike
): Component {
    if (toolName === "file_edit") return renderFileEditResultComponent(result, options, theme, context);
    return setText(
        context.lastComponent,
        formatPiToolResult(toolName, result, options.expanded, theme, context.isError)
    );
}

export function formatPiToolCall(toolName: string, args: unknown, theme?: PiThemeLike): string {
    const record = asRecord(args);
    const title = style(theme, "toolTitle", toolName, true);
    if (record === undefined) return title;

    switch (toolName) {
        case "file_read":
            return joinCall(title, [stringField(record, "path"), stringField(record, "selector"), option(record, "view")], theme);
        case "file_search": {
            const pattern = stringField(record, "pattern");
            const paths = stringArrayField(record, "paths");
            return joinCall(title, [
                pattern === undefined ? undefined : `/${pattern}/`,
                paths.length === 0 ? undefined : `in ${paths.join(", ")}`
            ], theme);
        }
        case "file_find": {
            const paths = stringArrayField(record, "paths");
            return joinCall(title, [paths.length === 0 ? undefined : paths.join(", ")], theme);
        }
        case "file_edit":
            return formatFileEditStaticCall(stringField(record, "changes"), theme);
        case "bash_run":
            return formatCommandCall(title, record, theme, "$ ");
        case "tmux_run":
            return formatCommandCall(title, record, theme, "↳ ");
        case "tmux_read":
            return joinCall(title, [stringField(record, "task"), option(record, "line"), option(record, "timeMs")], theme);
        case "tmux_input":
            return joinCall(title, [stringField(record, "task") ?? stringField(record, "pane"), previewScalar(record.input)], theme);
        case "tmux_inspect":
            return joinCall(title, [stringField(record, "pane") ?? stringField(record, "panes")], theme);
        default:
            return joinCall(title, summarizeRecord(record), theme);
    }
}

export function formatPiToolResult(
    toolName: string,
    result: PiToolRenderResultLike,
    expanded: boolean,
    theme?: PiThemeLike,
    isError = false
): string {
    let lines: string[];
    switch (toolName) {
        case "file_read":
            lines = renderFileRead(result.details);
            break;
        case "file_search":
            lines = renderFileSearch(result.details);
            break;
        case "file_edit":
            lines = renderFileEditFallback(result.details, theme);
            break;
        case "bash_run":
            lines = renderBashResult(result.details);
            break;
        case "tmux_run":
        case "tmux_read":
        case "tmux_inspect":
        case "tmux_input":
            lines = renderTmuxResult(result.details);
            break;
        default:
            lines = renderStructured(result.details);
            break;
    }

    if (lines.length === 0) lines = textContentLines(result);
    const clipped = clipLines(lines, expanded ? expandedLineLimit : collapsedLineLimit);
    return clipped.map((line) => style(theme, isError ? "error" : "toolOutput", line)).join("\n");
}

function renderFileRead(value: JsonValue | undefined): string[] {
    const record = asRecord(value);
    const content = record === undefined ? undefined : stringField(record, "content");
    return content === undefined ? renderStructured(value) : content.split("\n");
}

function renderFileSearch(value: JsonValue | undefined): string[] {
    const record = asRecord(value);
    if (record === undefined || !Array.isArray(record.files)) return renderStructured(value);
    const lines: string[] = [];
    for (const entry of record.files) {
        const file = asRecord(entry);
        if (file === undefined) continue;
        const path = stringField(file, "path");
        const content = stringField(file, "content");
        if (path !== undefined) lines.push(path);
        if (content !== undefined) lines.push(...content.split("\n").map((line) => `  ${line}`));
    }
    appendComments(lines, record);
    return lines;
}

function renderBashResult(value: JsonValue | undefined): string[] {
    const record = asRecord(value);
    if (record === undefined) return [];
    const lines: string[] = [];
    const stdout = stringField(record, "stdout");
    const stderr = stringField(record, "stderr");
    if (stdout) lines.push(...stdout.replace(/\n$/u, "").split("\n"));
    if (stderr) lines.push(...stderr.replace(/\n$/u, "").split("\n").map((line) => `stderr: ${line}`));
    if (record.exitCode !== undefined || record.durationMs !== undefined) {
        lines.push([
            record.exitCode === undefined ? undefined : `exit ${String(record.exitCode)}`,
            typeof record.durationMs === "number" ? `${record.durationMs} ms` : undefined
        ].filter(Boolean).join(" · "));
    }
    return lines.length === 0 ? renderStructured(value) : lines;
}

function renderTmuxResult(value: JsonValue | undefined): string[] {
    const record = asRecord(value);
    if (record === undefined) return [];
    const lines: string[] = [];
    const output = stringField(record, "output");
    if (output) lines.push(...output.split("\n"));
    const task = asRecord(record.task);
    if (task !== undefined) {
        const summary = [stringField(task, "id"), previewScalar(task.status)].filter(Boolean).join(" · ");
        if (summary) lines.push(summary);
    }
    appendComments(lines, record);
    return lines.length === 0 ? renderStructured(value) : lines;
}

function setText(component: Component | undefined, text: string): Component {
    if (component instanceof Text) {
        component.setText(text);
        return component;
    }
    return new Text(text, 0, 0);
}

function formatCommandCall(title: string, record: Record<string, unknown>, theme: PiThemeLike | undefined, prompt: string): string {
    const command = stringField(record, "command");
    return [
        title,
        command === undefined ? undefined : style(theme, "accent", `${prompt}${oneLine(command, 120)}`),
        stringField(record, "cwd") === undefined ? undefined : style(theme, "muted", `in ${stringField(record, "cwd")}`),
        stringField(record, "wait") === undefined ? undefined : style(theme, "muted", `wait=${stringField(record, "wait")}`)
    ].filter((value): value is string => value !== undefined).join(" ");
}

function joinCall(title: string, values: Array<string | undefined>, theme?: PiThemeLike): string {
    return [title, ...values
        .filter((value): value is string => value !== undefined && value.length > 0)
        .map((value) => style(theme, "toolOutput", value))].join(" ");
}

function summarizeRecord(record: Record<string, unknown>): Array<string | undefined> {
    return Object.entries(record)
        .filter(([key]) => !["ctxId", "instance"].includes(key))
        .slice(0, 4)
        .map(([key, value]) => {
            const preview = previewScalar(value);
            return preview === undefined ? undefined : `${key}=${preview}`;
        });
}

function appendComments(lines: string[], record: Record<string, unknown>): void {
    if (!Array.isArray(record.comment)) return;
    for (const comment of record.comment) if (typeof comment === "string" && comment.length > 0) lines.push(comment);
}

function renderStructured(value: JsonValue | undefined): string[] {
    if (value === undefined || value === null) return [];
    if (typeof value !== "object") return [String(value)];
    if (Array.isArray(value)) {
        return value.flatMap((entry) => {
            const nested = renderStructured(entry);
            return nested.length === 0 ? [] : [`• ${nested[0]}`, ...nested.slice(1).map((line) => `  ${line}`)];
        });
    }
    const lines: string[] = [];
    for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined || entry === null) continue;
        if (typeof entry !== "object") lines.push(`${key}: ${oneLine(String(entry), 240)}`);
        else {
            lines.push(`${key}:`);
            lines.push(...renderStructured(entry as JsonValue).map((line) => `  ${line}`));
        }
    }
    return lines;
}

function textContentLines(result: PiToolRenderResultLike): string[] {
    return result.content
        .filter((entry) => entry.type === "text" && typeof entry.text === "string")
        .flatMap((entry) => entry.text!.split("\n"));
}

function clipLines(lines: string[], limit: number): string[] {
    return lines.length <= limit ? lines : [...lines.slice(0, limit), `… (${lines.length - limit} more lines, Ctrl+O to expand)`];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
    return typeof record[key] === "string" ? record[key] : undefined;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
    return Array.isArray(record[key]) ? record[key].filter((value): value is string => typeof value === "string") : [];
}

function option(record: Record<string, unknown>, key: string): string | undefined {
    const value = previewScalar(record[key]);
    return value === undefined ? undefined : `${key}=${value}`;
}

function previewScalar(value: unknown): string | undefined {
    if (typeof value === "string") return oneLine(value, 80);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return undefined;
}

function oneLine(value: string, limit: number): string {
    const flattened = value.replace(/\s+/gu, " ").trim();
    return flattened.length <= limit ? flattened : `${flattened.slice(0, limit - 1)}…`;
}

function style(theme: PiThemeLike | undefined, role: string, text: string, bold = false): string {
    if (theme === undefined) return text;
    return theme.fg(role, bold ? theme.bold(text) : text);
}
