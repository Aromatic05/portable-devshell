import type { Component } from "@earendil-works/pi-tui";

import type { JsonValue } from "@portable-devshell/shared";

import type {
    PiThemeLike,
    PiToolRenderContextLike,
    PiToolRenderResultLike,
    PiToolRenderResultOptionsLike
} from "./renderer-types.js";
import {
    asRecord,
    joinCall,
    oneLine,
    option,
    OutputPreviewComponent,
    previewInput,
    previewScalar,
    setText,
    stringField,
    stringList,
    style,
    tailWithHint,
    textContentLines
} from "./renderer-utils.js";

export function formatTmuxCall(toolName: string, record: Record<string, unknown>, theme?: PiThemeLike): string {
    switch (toolName) {
        case "tmux_run": {
            const command = stringField(record, "command");
            const title = style(theme, "toolTitle", command === undefined ? "↳ ..." : `↳ ${oneLine(command, 180)}`, true);
            const meta = [
                stringField(record, "cwd") === undefined ? undefined : `in ${stringField(record, "cwd")}`,
                stringField(record, "wait") === undefined ? undefined : `wait ${stringField(record, "wait")}`
            ].filter((value): value is string => value !== undefined).join(" · ");
            return meta.length === 0 ? title : `${title} ${style(theme, "muted", meta)}`;
        }
        case "tmux_read":
            return joinCall(style(theme, "toolTitle", "tmux read", true), [stringField(record, "task"), option(record, "line")], theme);
        case "tmux_input":
            return joinCall(style(theme, "toolTitle", "tmux input", true), [
                stringField(record, "task") ?? stringField(record, "pane"),
                previewInput(record.input)
            ], theme);
        case "tmux_inspect":
            return joinCall(style(theme, "toolTitle", "tmux inspect", true), [stringField(record, "pane") ?? stringField(record, "panes") ?? "main"], theme);
        case "tmux_list":
            return style(theme, "toolTitle", "tmux list", true);
        case "tmux_create":
            return joinCall(style(theme, "toolTitle", "tmux create", true), [stringField(record, "name"), stringField(record, "cwd")], theme);
        case "tmux_close":
            return joinCall(style(theme, "toolTitle", "tmux close", true), [stringField(record, "task") ?? stringField(record, "pane")], theme);
        default:
            return style(theme, "toolTitle", toolName, true);
    }
}

export function renderTerminalResultComponent(
    toolName: string,
    result: PiToolRenderResultLike,
    options: PiToolRenderResultOptionsLike,
    theme: PiThemeLike,
    context: PiToolRenderContextLike
): Component {
    const record = asRecord(result.details);
    if (record === undefined) return setText(context.lastComponent, textContentLines(result).join("\n"));
    const output = stringList(record.output).map((line) => style(theme, "toolOutput", line));
    const footer = tmuxStatusLines(toolName, record, theme);
    const component = context.lastComponent instanceof OutputPreviewComponent
        ? context.lastComponent
        : new OutputPreviewComponent();
    component.setState({ expanded: options.expanded, footer, lines: output, tailLines: 8, theme });
    return component;
}

export function renderTmuxResult(toolName: string, value: JsonValue | undefined, expanded: boolean): string[] {
    const record = asRecord(value);
    if (record === undefined) return [];
    switch (toolName) {
        case "tmux_run":
        case "tmux_read":
        case "tmux_input": {
            const lines = expanded ? stringList(record.output) : tailWithHint(stringList(record.output), 8);
            lines.push(...tmuxStatusLines(toolName, record));
            return lines;
        }
        case "tmux_inspect":
            return renderTmuxInspect(record, expanded);
        case "tmux_list":
            return renderTmuxList(record);
        case "tmux_create": {
            const pane = asRecord(record.pane);
            const summary = pane === undefined ? undefined : formatPaneRef(pane);
            return [...(summary === undefined ? [] : [`created ${summary}`]), ...warningLines(record)];
        }
        case "tmux_close": {
            const closed = stringField(record, "closedTaskId") ?? stringField(record, "closedPaneId");
            return [...(closed === undefined ? [] : [`closed ${closed}`]), ...warningLines(record)];
        }
        default:
            return [];
    }
}

function tmuxStatusLines(toolName: string, record: Record<string, unknown>, theme?: PiThemeLike): string[] {
    const lines: string[] = [];
    const task = asRecord(record.task);
    const pane = asRecord(record.pane);
    const state = [
        task === undefined ? undefined : stringField(task, "id"),
        task === undefined ? undefined : previewScalar(task.status),
        record.detached === true ? "detached" : undefined,
        record.interrupted === true ? "interrupted" : undefined,
        record.timedOut === true ? "timed out" : undefined,
        stringField(record, "waitReason")
    ].filter((value): value is string => value !== undefined).join(" · ");
    if (state.length > 0) lines.push(style(theme, taskStatusRole(task), state));
    if (pane !== undefined && toolName !== "tmux_run") {
        const paneSummary = formatPaneRef(pane);
        if (paneSummary !== undefined) lines.push(style(theme, "muted", paneSummary));
    }
    lines.push(...warningLines(record).map((line) => style(theme, "warning", line)));
    return lines;
}

function renderTmuxInspect(record: Record<string, unknown>, expanded: boolean): string[] {
    if (!Array.isArray(record.panes)) return [];
    const lines: string[] = [];
    for (const paneValue of record.panes) {
        const pane = asRecord(paneValue);
        if (pane === undefined) continue;
        if (lines.length > 0) lines.push("");
        lines.push([
            stringField(pane, "name") ?? stringField(pane, "id") ?? "pane",
            stringField(pane, "status"),
            stringField(pane, "cwd"),
            stringField(pane, "command")
        ].filter((value): value is string => value !== undefined).join(" · "));
        const screen = stringList(pane.lines);
        lines.push(...(expanded ? screen : tailWithHint(screen, 12)).map((line) => `  ${line}`));
    }
    lines.push(...warningLines(record));
    return lines;
}

function renderTmuxList(record: Record<string, unknown>): string[] {
    if (!Array.isArray(record.panes)) return warningLines(record);
    const lines = record.panes.map(asRecord).filter((pane): pane is Record<string, unknown> => pane !== undefined).map((pane) => {
        const task = asRecord(pane.task);
        return [
            stringField(pane, "name") ?? stringField(pane, "id") ?? "pane",
            stringField(pane, "status"),
            task === undefined ? undefined : `${stringField(task, "id") ?? "task"}:${stringField(task, "status") ?? "?"}`
        ].filter((value): value is string => value !== undefined).join(" · ");
    });
    lines.push(...warningLines(record));
    return lines;
}

function formatPaneRef(pane: Record<string, unknown>): string | undefined {
    const name = stringField(pane, "name");
    const id = stringField(pane, "id");
    if (name === undefined) return id;
    return id === undefined || id === name ? name : `${name} · ${id}`;
}

function taskStatusRole(task: Record<string, unknown> | undefined): string {
    const status = task === undefined ? undefined : stringField(task, "status");
    return status === "failed" || status === "cancelled" ? "error" : status === "running" ? "warning" : "muted";
}

function warningLines(record: Record<string, unknown>): string[] {
    if (!Array.isArray(record.warnings)) return [];
    return record.warnings.map(asRecord).filter((warning): warning is Record<string, unknown> => warning !== undefined).map((warning) => {
        const pane = stringField(warning, "pane");
        const message = stringField(warning, "message") ?? stringField(warning, "code") ?? "warning";
        return `[${pane === undefined ? "warning" : pane}] ${message}`;
    });
}
