import type { ControlErrorBody } from "../error/ErrorBodyControl.js";
import type { JsonValue } from "../type/TypeJsonValue.js";
import { crossToolErrorHints } from "./CrossToolErrorHints.js";
import { errorHint, type ToolDiagnosticHint } from "./ToolDiagnosticHint.js";
import { artifactControlErrorHints, artifactTransferResultHints } from "./control/ArtifactControlHints.js";
import { instanceErrorHints } from "./control/InstanceHints.js";
import { todoErrorHints } from "./control/TodoHints.js";
import { artifactReadErrorHints, artifactReadResultHints } from "./worker/ArtifactReadHints.js";
import { bashErrorHints, bashResultHints } from "./worker/BashHints.js";
import {
    fileEditResultHints,
    fileErrorHints,
    fileFindResultHints,
    fileReadResultHints,
    fileSearchResultHints
} from "./worker/FileHints.js";
import {
    tmuxCloseResultHints,
    tmuxCreateResultHints,
    tmuxErrorHints,
    tmuxInspectResultHints,
    tmuxListResultHints,
    tmuxTaskResultHints
} from "./worker/TmuxHints.js";

type ResultResolver = (toolName: string, result: JsonValue) => ToolDiagnosticHint[];
type ErrorResolver = (toolName: string, body: ControlErrorBody) => ToolDiagnosticHint[];

const resultResolvers: Record<string, ResultResolver> = {
    artifact_read: (_toolName, result) => artifactReadResultHints(result),
    artifact_transfer: (_toolName, result) => artifactTransferResultHints(result),
    bash_run: (_toolName, result) => bashResultHints(result),
    file_edit: (_toolName, result) => fileEditResultHints(result),
    file_find: (_toolName, result) => fileFindResultHints(result),
    file_read: (_toolName, result) => fileReadResultHints(result),
    file_search: (_toolName, result) => fileSearchResultHints(result),
    tmux_close: (_toolName, result) => tmuxCloseResultHints(result),
    tmux_create: (_toolName, result) => tmuxCreateResultHints(result),
    tmux_input: (toolName, result) => tmuxTaskResultHints(toolName, result),
    tmux_inspect: (_toolName, result) => tmuxInspectResultHints(result),
    tmux_list: (_toolName, result) => tmuxListResultHints(result),
    tmux_read: (toolName, result) => tmuxTaskResultHints(toolName, result),
    tmux_run: (toolName, result) => tmuxTaskResultHints(toolName, result)
};

const fileTools = new Set(["file_read", "file_edit", "file_find", "file_search", "file_info"]);
const tmuxTools = new Set(["tmux_run", "tmux_input", "tmux_read", "tmux_inspect", "tmux_list", "tmux_create", "tmux_close"]);
const artifactControlTools = new Set(["artifact_viewImage", "artifact_share", "artifact_transfer"]);
const instanceTools = new Set(["instance_list", "instance_status", "instance_create", "instance_connect", "instance_stop"]);
const todoTools = new Set(["todo_read", "todo_write"]);

function errorResolverFor(toolName: string): ErrorResolver | undefined {
    if (toolName === "bash_run") return (_name, body) => bashErrorHints(body);
    if (toolName === "artifact_read") return (_name, body) => artifactReadErrorHints(body);
    if (fileTools.has(toolName)) return (name, body) => fileErrorHints(name, body);
    if (tmuxTools.has(toolName)) return (name, body) => tmuxErrorHints(name, body);
    if (artifactControlTools.has(toolName)) return (_name, body) => artifactControlErrorHints(body);
    if (instanceTools.has(toolName)) return (_name, body) => instanceErrorHints(body);
    if (todoTools.has(toolName)) return (_name, body) => todoErrorHints(body);
    return undefined;
}

export function resolveResultHints(toolName: string, result: JsonValue): ToolDiagnosticHint[] {
    const resolver = resultResolvers[toolName];
    return resolver === undefined ? [] : resolver(toolName, result);
}

export function resolveErrorHints(toolName: string, body: ControlErrorBody): ToolDiagnosticHint[] {
    const resolver = errorResolverFor(toolName);
    const hints: ToolDiagnosticHint[] = [
        ...(resolver === undefined ? [] : resolver(toolName, body)),
        ...crossToolErrorHints(body)
    ];
    if (hints.length === 0) {
        hints.push(errorHint(
            "error.unknown",
            "Inspect the error before retrying."
        ));
    }
    return hints;
}
