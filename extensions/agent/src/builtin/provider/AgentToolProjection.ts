import type { ExtensionJsonValue } from "@portable-devshell/extension";

import type {
    AgentModelToolDefinition,
    AgentToolDefinition
} from "./AgentToolSession.js";

const AGENT_MODEL_TOOL_NAMES = new Set([
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
]);

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
    if (toolName === "bash_run" && isRecord(value)) return renderBashModelToolResult(value);
    if (toolName !== "file_edit" || !isRecord(value)) return renderToolResult(value);
    const operations = value.operations;
    if (!Array.isArray(operations)) return renderToolResult(value);
    return operations.map((operation) => {
        if (!isRecord(operation)) return renderToolResult(operation);
        const action = typeof operation.action === "string" ? operation.action : "edit";
        const path = typeof operation.path === "string" ? operation.path : "<unknown>";
        const status = typeof operation.status === "string" ? operation.status : "unknown";
        const added = typeof operation.addedLines === "number" ? `+${operation.addedLines}` : undefined;
        const removed = typeof operation.removedLines === "number" ? `-${operation.removedLines}` : undefined;
        return [action, path, status, added, removed].filter(Boolean).join(" ");
    }).join("\n");
}

function renderBashModelToolResult(value: Record<string, ExtensionJsonValue>): string {
    const {
        stdoutArtifact: _stdoutArtifact,
        stderrArtifact: _stderrArtifact,
        stdoutPath,
        stderrPath,
        ...rest
    } = value;
    return renderToolResult({
        ...(typeof stdoutPath === "string" ? { stdoutPath } : {}),
        ...(typeof stderrPath === "string" ? { stderrPath } : {}),
        ...rest
    });
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
