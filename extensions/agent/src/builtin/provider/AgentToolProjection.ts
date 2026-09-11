import type { ExtensionJsonValue } from "@portable-devshell/extension";

import type {
    AgentModelToolDefinition,
    AgentToolDefinition
} from "./AgentToolSession.js";

const CONSUMER_ONLY_INPUT_PROPERTIES = new Set([
    "ctxId",
    "explanation",
    "instance",
    "purpose"
]);

const TOOL_INTERNAL_INPUT_PROPERTIES = new Map<string, ReadonlySet<string>>([
    ["file_edit", new Set(["resultDetail"])],
    ["tmux_read", new Set(["consumeOutput"])],
    ["tmux_run", new Set(["consumeOutput"])]
]);

const MAX_MODEL_TOOL_RESULT_CHARACTERS = 12_000;
const MAX_SEMANTIC_CONTENT_CHARACTERS = 9_000;

type AgentModelToolResultProjector = (value: Record<string, ExtensionJsonValue>) => string;

const AGENT_MODEL_TOOL_RESULT_PROJECTORS = new Map<string, AgentModelToolResultProjector>([
    ["bash_run", renderBashModelToolResult],
    ["file_edit", renderFileEditModelToolResult],
    ["file_glob", renderFileGlobModelToolResult],
    ["file_grep", renderFileGrepModelToolResult],
    ["file_read", renderFileReadModelToolResult],
    ["tmux_close", renderTmuxCloseModelToolResult],
    ["tmux_create", renderTmuxCreateModelToolResult],
    ["tmux_input", renderTmuxTaskModelToolResult],
    ["tmux_inspect", renderTmuxInspectModelToolResult],
    ["tmux_list", renderTmuxListModelToolResult],
    ["tmux_read", renderTmuxTaskModelToolResult],
    ["tmux_run", renderTmuxTaskModelToolResult]
]);

const AGENT_MODEL_TOOL_NAMES = new Set(AGENT_MODEL_TOOL_RESULT_PROJECTORS.keys());

export function projectAgentModelTools(
    tools: readonly AgentToolDefinition[]
): AgentModelToolDefinition[] {
    return tools
        .filter((tool) => AGENT_MODEL_TOOL_NAMES.has(tool.name))
        .map((tool) => ({
            description: tool.description,
            inputSchema: projectAgentModelInputSchema(tool.name, tool.inputSchema),
            name: tool.name
        }));
}

export function prepareAgentModelToolInput(toolName: string, params: unknown): ExtensionJsonValue {
    const input = asJsonValue(params);
    if (toolName !== "file_edit" || input === null || Array.isArray(input) || typeof input !== "object") {
        return input;
    }
    return { ...input, resultDetail: "diff" };
}

export function projectAgentModelToolResult(toolName: string, value: ExtensionJsonValue): string {
    return limitModelToolResult(renderAgentModelToolResult(toolName, value));
}

function projectAgentModelInputSchema(toolName: string, schema: ExtensionJsonValue): ExtensionJsonValue {
    if (!isRecord(schema)) return schema;
    const properties = isRecord(schema.properties) ? { ...schema.properties } : undefined;
    if (properties === undefined) return schema;

    const hidden = new Set([
        ...CONSUMER_ONLY_INPUT_PROPERTIES,
        ...(TOOL_INTERNAL_INPUT_PROPERTIES.get(toolName) ?? [])
    ]);
    for (const property of hidden) delete properties[property];

    const required = Array.isArray(schema.required)
        ? schema.required.filter((entry) => typeof entry !== "string" || !hidden.has(entry))
        : undefined;
    return {
        ...schema,
        properties,
        ...(required === undefined ? {} : { required })
    };
}

function renderAgentModelToolResult(toolName: string, value: ExtensionJsonValue): string {
    if (!isRecord(value)) return renderToolResult(value);
    return AGENT_MODEL_TOOL_RESULT_PROJECTORS.get(toolName)?.(value) ?? renderToolResult(value);
}

function renderFileEditModelToolResult(value: Record<string, ExtensionJsonValue>): string {
    const operations = value.operations;
    if (!Array.isArray(operations)) return renderToolResult(value);
    return operations.map((operation) => {
        if (!isRecord(operation)) return renderToolResult(operation);
        const action = typeof operation.action === "string" ? operation.action : "edit";
        const path = typeof operation.path === "string" ? operation.path : "<unknown>";
        const status = typeof operation.status === "string" ? operation.status : "unknown";
        const added = typeof operation.addedLines === "number" ? `+${operation.addedLines}` : undefined;
        const removed = typeof operation.removedLines === "number" ? `-${operation.removedLines}` : undefined;
        const movedFrom = typeof operation.movedFrom === "string" ? `from=${operation.movedFrom}` : undefined;
        const summary = [action, path, status, added, removed, movedFrom].filter(Boolean).join(" ");
        const errorRecord = isRecord(operation.error) ? operation.error : undefined;
        const error = errorRecord === undefined
            ? undefined
            : [
                  typeof errorRecord.code === "string" ? errorRecord.code : "file.editFailed",
                  typeof errorRecord.message === "string" ? errorRecord.message : undefined,
                  errorRecord.retryable === true ? "retryable" : undefined
              ].filter(Boolean).join(": ")
        const errorDetails = errorRecord?.details === undefined
            ? undefined
            : `errorDetails=${previewText(renderToolResult(errorRecord.details), 1_000).text}`;
        return [
            summary,
            error === undefined ? undefined : `error=${error}`,
            errorDetails,
            operation.truncated === true ? "diffTruncated=true" : undefined
        ]
            .filter(Boolean)
            .join("\n");
    }).join("\n");
}

function renderBashModelToolResult(value: Record<string, ExtensionJsonValue>): string {
    const stdout = typeof value.stdout === "string" ? value.stdout : "";
    const stderr = typeof value.stderr === "string" ? value.stderr : "";
    const stdoutPath = typeof value.stdoutPath === "string" ? value.stdoutPath : undefined;
    const stderrPath = typeof value.stderrPath === "string" ? value.stderrPath : undefined;
    const streams = [stdout.length > 0, stderr.length > 0].filter(Boolean).length;
    const streamBudget = Math.floor(MAX_SEMANTIC_CONTENT_CHARACTERS / Math.max(streams, 1));
    const lines = [
        compactFields([
            field("termination", value.termination),
            field("exitCode", value.exitCode),
            field("termSignal", value.termSignal),
            value.timedOut === true ? "timedOut=true" : undefined,
            field("durationMs", value.durationMs)
        ])
    ];
    if (stdout.length > 0) {
        const preview = previewText(stdout, streamBudget);
        lines.push(`stdout${streamLabel(value.stdoutBytes, value.stdoutTruncated)}:\n${preview.text}`);
        if (preview.clipped && stdoutPath === undefined) lines.push("stdoutProjectionClipped=true; rerun with narrower output if omitted text is required");
    }
    if (stderr.length > 0) {
        const preview = previewText(stderr, streamBudget);
        lines.push(`stderr${streamLabel(value.stderrBytes, value.stderrTruncated)}:\n${preview.text}`);
        if (preview.clipped && stderrPath === undefined) lines.push("stderrProjectionClipped=true; rerun with narrower output if omitted text is required");
    }
    if (stdoutPath !== undefined) lines.push(`stdoutRecovery=${stdoutPath}`);
    if (stderrPath !== undefined) lines.push(`stderrRecovery=${stderrPath}`);
    lines.push(...renderStringWarnings(value.artifactWarnings));
    return lines.filter((line) => line.length > 0).join("\n");
}

function renderFileReadModelToolResult(value: Record<string, ExtensionJsonValue>): string {
    const files = Array.isArray(value.files) ? value.files.filter(isRecord) : undefined;
    if (files === undefined) return renderToolResult(value);
    if (files.length === 0) return "No files returned.";
    const contentBudget = Math.max(80, Math.floor(MAX_SEMANTIC_CONTENT_CHARACTERS / files.length));
    return files.map((file) => {
        const path = typeof file.path === "string" ? file.path : "<unknown>";
        const view = typeof file.view === "string" ? file.view : "unknown";
        const header = compactFields([
            `file=${path}`,
            `view=${view}`,
            field("language", file.language),
            field("parseStatus", file.parseStatus)
        ]);
        if (view === "metadata" && isRecord(file.metadata)) {
            return `${header}\nmetadata=${renderCompactRecord(file.metadata)}`;
        }
        const content = typeof file.content === "string" ? file.content : "";
        const preview = previewText(content, contentBudget);
        const continuation = typeof file.nextSelector === "string"
            ? `nextSelector=${file.nextSelector}; continue with file_read on ${path}`
            : preview.clipped
                ? `projectionClipped=true; re-read ${path} with a narrower selector`
                : undefined;
        return [header, preview.text, file.truncated === true ? "workerTruncated=true" : undefined, continuation]
            .filter((line): line is string => typeof line === "string" && line.length > 0)
            .join("\n");
    }).join("\n\n");
}

function renderFileGlobModelToolResult(value: Record<string, ExtensionJsonValue>): string {
    const entries = Array.isArray(value.entries) ? value.entries.filter(isRecord) : undefined;
    if (entries === undefined) return renderToolResult(value);
    if (entries.length === 0) return typeof value.nextCursor === "string"
        ? `No entries in this page.\nnextCursor=${value.nextCursor}; continue with file_glob cursor only`
        : "No entries.";
    const rendered = entries.map((entry) => {
        const path = typeof entry.path === "string" ? entry.path : "<unknown>";
        return entry.type === "directory" ? `${path}/` : path;
    }).join("\n");
    const preview = previewText(rendered, MAX_SEMANTIC_CONTENT_CHARACTERS);
    const lines = [preview.text];
    if (preview.clipped) lines.push("projectionClipped=true; rerun file_glob with narrower patterns if omitted paths are required");
    if (typeof value.nextCursor === "string") lines.push(`nextCursor=${value.nextCursor}; continue with file_glob cursor only`);
    return lines.filter((line) => line.length > 0).join("\n");
}

function renderFileGrepModelToolResult(value: Record<string, ExtensionJsonValue>): string {
    const files = Array.isArray(value.files) ? value.files.filter(isRecord) : undefined;
    if (files === undefined) return renderToolResult(value);
    if (files.length === 0) return typeof value.nextCursor === "string"
        ? `No matches in this page.\nnextCursor=${value.nextCursor}; continue with file_grep cursor only`
        : "No matches.";
    const contentBudget = Math.max(80, Math.floor(MAX_SEMANTIC_CONTENT_CHARACTERS / files.length));
    const sections = files.map((file) => {
        const path = typeof file.path === "string" ? file.path : "<unknown>";
        const content = typeof file.content === "string" ? file.content : "";
        const preview = previewText(content, contentBudget);
        const continuation = typeof file.nextLine === "number"
            ? `nextLine=${file.nextLine}; continue file_grep against exact path ${path}`
            : preview.clipped
                ? `projectionClipped=true; use file_read on ${path} or rerun file_grep against that exact path`
                : undefined;
        return [`file=${path}`, preview.text, file.truncated === true ? "workerTruncated=true" : undefined, continuation]
            .filter((line): line is string => typeof line === "string" && line.length > 0)
            .join("\n");
    });
    if (typeof value.nextCursor === "string") sections.push(`nextCursor=${value.nextCursor}; continue with file_grep cursor only`);
    return sections.join("\n\n");
}

function renderTmuxTaskModelToolResult(value: Record<string, ExtensionJsonValue>): string {
    const task = isRecord(value.task) ? value.task : undefined;
    const pane = isRecord(value.pane) ? value.pane : undefined;
    const taskId = task !== undefined && typeof task.id === "string" ? task.id : undefined;
    const paneId = pane !== undefined && typeof pane.id === "string" ? pane.id : undefined;
    const lines = [compactFields([
        field("task", taskId),
        field("status", task?.status),
        field("pane", paneId),
        field("paneName", pane?.name),
        field("waitReason", value.waitReason),
        field("timeout", value.timeout),
        value.detached === true ? "detached=true" : undefined,
        value.interrupted === true ? "interrupted=true" : undefined,
        value.timedOut === true ? "timedOut=true" : undefined
    ])];
    const output = stringArray(value.output);
    if (output.length > 0) {
        const preview = previewText(output.join("\n"), MAX_SEMANTIC_CONTENT_CHARACTERS);
        lines.push(`output:\n${preview.text}`);
        if (preview.clipped) {
            if (taskId !== undefined) lines.push(`projectionClipped=true; continue with tmux_read task=${taskId}`);
            else if (paneId !== undefined) lines.push(`projectionClipped=true; inspect pane=${paneId} for omitted terminal content`);
        }
    }
    lines.push(...renderTmuxWarnings(value.warnings));
    return lines.filter((line) => line.length > 0).join("\n");
}

function renderTmuxInspectModelToolResult(value: Record<string, ExtensionJsonValue>): string {
    const panes = Array.isArray(value.panes) ? value.panes.filter(isRecord) : undefined;
    if (panes === undefined) return renderToolResult(value);
    if (panes.length === 0) return [...renderTmuxWarnings(value.warnings), "No panes returned."].join("\n");
    const lineBudget = Math.max(80, Math.floor(MAX_SEMANTIC_CONTENT_CHARACTERS / panes.length));
    const sections = panes.map((pane) => {
        const task = isRecord(pane.task) ? pane.task : undefined;
        const size = isRecord(pane.size) ? pane.size : undefined;
        const paneId = typeof pane.id === "string" ? pane.id : undefined;
        const header = compactFields([
            field("pane", paneId),
            field("name", pane.name),
            field("status", pane.status),
            field("cwd", pane.cwd),
            field("command", pane.command),
            size === undefined ? undefined : `size=${String(size.columns ?? "?")}x${String(size.rows ?? "?")}`,
            pane.locked === true ? "locked=true" : undefined,
            field("task", task?.id),
            field("taskStatus", task?.status)
        ]);
        const terminalLines = stringArray(pane.lines);
        if (terminalLines.length === 0) return header;
        const preview = previewText(terminalLines.join("\n"), lineBudget);
        return [
            header,
            `lines:\n${preview.text}`,
            preview.clipped && paneId !== undefined
                ? `projectionClipped=true; rerun tmux_inspect pane=${paneId} with narrower start/end`
                : undefined
        ].filter((line): line is string => typeof line === "string" && line.length > 0).join("\n");
    });
    sections.push(...renderTmuxWarnings(value.warnings));
    return sections.join("\n\n");
}

function renderTmuxListModelToolResult(value: Record<string, ExtensionJsonValue>): string {
    const panes = Array.isArray(value.panes) ? value.panes.filter(isRecord) : undefined;
    if (panes === undefined) return renderToolResult(value);
    const lines = panes.map((pane) => {
        const task = isRecord(pane.task) ? pane.task : undefined;
        return compactFields([
            field("pane", pane.id),
            field("name", pane.name),
            field("status", pane.status),
            field("task", task?.id),
            field("taskStatus", task?.status)
        ]);
    });
    if (lines.length === 0) lines.push("No panes or active tasks.");
    lines.push(...renderTmuxWarnings(value.warnings));
    return lines.join("\n");
}

function renderTmuxCreateModelToolResult(value: Record<string, ExtensionJsonValue>): string {
    const pane = isRecord(value.pane) ? value.pane : undefined;
    if (pane === undefined) return renderToolResult(value);
    return [compactFields([field("pane", pane.id), field("name", pane.name)]), ...renderTmuxWarnings(value.warnings)]
        .filter((line) => line.length > 0)
        .join("\n");
}

function renderTmuxCloseModelToolResult(value: Record<string, ExtensionJsonValue>): string {
    const closed = typeof value.closedTaskId === "string"
        ? `closedTask=${value.closedTaskId}`
        : typeof value.closedPaneId === "string"
            ? `closedPane=${value.closedPaneId}`
            : "closed";
    return [closed, ...renderTmuxWarnings(value.warnings)].join("\n");
}

function renderTmuxWarnings(value: ExtensionJsonValue | undefined): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter(isRecord).map((warning) => compactFields([
        "warning",
        field("code", warning.code),
        field("pane", warning.pane),
        typeof warning.message === "string" ? warning.message : undefined
    ]));
}

function renderStringWarnings(value: ExtensionJsonValue | undefined): string[] {
    return stringArray(value).map((warning) => `warning=${warning}`);
}

function renderCompactRecord(value: Record<string, ExtensionJsonValue>): string {
    return JSON.stringify(value);
}

function streamLabel(bytes: ExtensionJsonValue | undefined, truncated: ExtensionJsonValue | undefined): string {
    const attributes = [typeof bytes === "number" ? `${bytes} bytes` : undefined, truncated === true ? "worker-truncated" : undefined]
        .filter(Boolean);
    return attributes.length === 0 ? "" : ` (${attributes.join(", ")})`;
}

function stringArray(value: ExtensionJsonValue | undefined): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function compactFields(values: Array<string | undefined>): string {
    return values.filter((value): value is string => value !== undefined && value.length > 0).join(" ");
}

function field(name: string, value: ExtensionJsonValue | undefined): string | undefined {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? `${name}=${String(value)}`
        : undefined;
}

function previewText(value: string, maxCharacters: number): { clipped: boolean; text: string } {
    if (value.length <= maxCharacters) return { clipped: false, text: value };
    const marker = `\n... [semantic preview clipped: ${value.length} characters total] ...\n`;
    const retainedCharacters = Math.max(maxCharacters - marker.length, 0);
    const headCharacters = Math.ceil(retainedCharacters / 2);
    const tailCharacters = retainedCharacters - headCharacters;
    return {
        clipped: true,
        text: `${value.slice(0, headCharacters)}${marker}${tailCharacters === 0 ? "" : value.slice(-tailCharacters)}`
    };
}

function limitModelToolResult(value: string): string {
    if (value.length <= MAX_MODEL_TOOL_RESULT_CHARACTERS) return value;
    const marker = `\n... [tool result truncated: ${value.length} characters total] ...\n`;
    const retainedCharacters = MAX_MODEL_TOOL_RESULT_CHARACTERS - marker.length;
    const headCharacters = Math.ceil(retainedCharacters / 2);
    const tailCharacters = retainedCharacters - headCharacters;
    return `${value.slice(0, headCharacters)}${marker}${value.slice(-tailCharacters)}`;
}

function asJsonValue(value: unknown): ExtensionJsonValue {
    if (!isJsonValue(value)) throw new TypeError("Agent tool arguments are not JSON serializable.");
    return value;
}

function isJsonValue(value: unknown): value is ExtensionJsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJsonValue);
    if (typeof value !== "object") return false;
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function isRecord(value: ExtensionJsonValue): value is Record<string, ExtensionJsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderToolResult(value: ExtensionJsonValue): string {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
