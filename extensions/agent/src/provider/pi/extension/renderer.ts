import type { Component } from "@earendil-works/pi-tui";

import {
    formatFileEditStaticCall,
    renderFileEditCallComponent,
    renderFileEditFallback,
    renderFileEditResultComponent
} from "./file-edit-renderer.js";
import {
    formatGlobCall,
    formatGrepCall,
    formatReadCall,
    renderFileGlob,
    renderFileGrep,
    renderFileRead,
    renderFileReadComponent,
    renderFileSummaryComponent
} from "./file-tool-renderer.js";
import type {
    PiThemeLike,
    PiToolRenderContextLike,
    PiToolRenderResultLike,
    PiToolRenderResultOptionsLike
} from "./renderer-types.js";
import {
    asRecord,
    joinCall,
    joinStyled,
    renderError,
    renderStructured,
    setText,
    stringField,
    style,
    summarizeRecord,
    textContentLines
} from "./renderer-utils.js";
import { formatShellCall, renderBashResult, renderBashResultComponent } from "./shell-tool-renderer.js";
import { formatTmuxCall, renderTerminalResultComponent, renderTmuxResult } from "./tmux-tool-renderer.js";

export { parseEditChangeSet, renderWorkerUnifiedDiff } from "./file-edit-renderer.js";
export type {
    PiThemeLike,
    PiToolRenderContextLike,
    PiToolRenderResultLike,
    PiToolRenderResultOptionsLike
} from "./renderer-types.js";

export const devshellPiRendererToolNames = Object.freeze([
    "bash_run",
    "file_edit",
    "file_glob",
    "file_grep",
    "file_read",
    "tmux_close",
    "tmux_create",
    "tmux_input",
    "tmux_inspect",
    "tmux_list",
    "tmux_read",
    "tmux_run"
] as const);

const rendererToolNames = new Set<string>(devshellPiRendererToolNames);
const expandedLineLimit = 160;

export function hasExplicitPiToolRenderer(toolName: string): boolean {
    return rendererToolNames.has(toolName);
}

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
    if (context.isError) return setText(context.lastComponent, renderError(result, theme));

    switch (toolName) {
        case "file_read":
            return renderFileReadComponent(result, options, theme, context);
        case "file_glob":
        case "file_grep":
            return renderFileSummaryComponent(toolName, result, options, theme, context);
        case "bash_run":
            return renderBashResultComponent(result, options, theme, context);
        case "tmux_run":
        case "tmux_read":
        case "tmux_input":
            return renderTerminalResultComponent(toolName, result, options, theme, context);
        default:
            return setText(
                context.lastComponent,
                formatPiToolResult(toolName, result, options.expanded, theme, false)
            );
    }
}

export function formatPiToolCall(toolName: string, args: unknown, theme?: PiThemeLike): string {
    const record = asRecord(args);
    if (record === undefined) return style(theme, "toolTitle", displayToolLabel(toolName), true);

    switch (toolName) {
        case "bash_run":
            return formatShellCall(record, theme);
        case "file_edit":
            return formatFileEditStaticCall(stringField(record, "changes"), theme);
        case "file_glob":
            return formatGlobCall(record, theme);
        case "file_grep":
            return formatGrepCall(record, theme);
        case "file_read":
            return formatReadCall(record, theme);
        case "tmux_close":
        case "tmux_create":
        case "tmux_input":
        case "tmux_inspect":
        case "tmux_list":
        case "tmux_read":
        case "tmux_run":
            return formatTmuxCall(toolName, record, theme);
        default:
            return joinCall(style(theme, "toolTitle", toolName, true), summarizeRecord(record), theme);
    }
}

export function formatPiToolResult(
    toolName: string,
    result: PiToolRenderResultLike,
    expanded: boolean,
    theme?: PiThemeLike,
    isError = false
): string {
    if (isError) return renderError(result, theme);

    switch (toolName) {
        case "bash_run":
            return joinStyled(renderBashResult(result.details, expanded), theme);
        case "file_edit":
            return joinStyled(renderFileEditFallback(result.details, theme), theme);
        case "file_glob":
            return joinStyled(renderFileGlob(result.details, expanded), theme);
        case "file_grep":
            return joinStyled(renderFileGrep(result.details, expanded), theme);
        case "file_read":
            return joinStyled(renderFileRead(result.details, expanded), theme);
        case "tmux_close":
        case "tmux_create":
        case "tmux_input":
        case "tmux_inspect":
        case "tmux_list":
        case "tmux_read":
        case "tmux_run":
            return joinStyled(renderTmuxResult(toolName, result.details, expanded), theme);
        default: {
            let lines = renderStructured(result.details);
            if (lines.length === 0) lines = textContentLines(result);
            const clipped = lines.length <= (expanded ? expandedLineLimit : 18)
                ? lines
                : [...lines.slice(0, expanded ? expandedLineLimit : 18), "... (more output, Ctrl+O to expand)"];
            return joinStyled(clipped, theme);
        }
    }
}

function displayToolLabel(toolName: string): string {
    switch (toolName) {
        case "bash_run": return "$";
        case "file_glob": return "glob";
        case "file_grep": return "grep";
        case "file_read": return "read";
        default: return toolName.startsWith("tmux_") ? `tmux ${toolName.slice(5)}` : toolName;
    }
}
