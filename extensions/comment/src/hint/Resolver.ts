import type { RemoteErrorBody } from "@portable-devshell/shared";
import type { JsonValue } from "@portable-devshell/shared";
import type { ToolCallRewriteInvocation } from "@portable-devshell/extension/toolcall";
import { crossToolErrorHints } from "./tool/Error.js";
import { errorHint, type ToolDiagnosticHint } from "./Hint.js";
import { artifactControlErrorHints } from "./tool/control/Artifact.js";
import { instanceErrorHints } from "./tool/control/Instance.js";
import { bashErrorHints, bashResultHints } from "./tool/worker/Bash.js";
import { processErrorHints } from "./tool/worker/Process.js";
import {
    fileEditResultHints,
    fileErrorHints,
    fileGlobResultHints,
    fileGrepResultHints,
    fileReadResultHints,
} from "./tool/worker/File.js";


type ResultResolver = (
    toolName: string,
    result: JsonValue,
) => ToolDiagnosticHint[];
type ErrorResolver = (
    toolName: string,
    body: RemoteErrorBody,
) => ToolDiagnosticHint[];

const resultResolvers: Record<string, ResultResolver> = {
    bash_run: (_toolName, result) => bashResultHints(result),
    task_read: (_toolName, result) => bashResultHints(result),
    file_edit: (_toolName, result) => fileEditResultHints(result),
    file_glob: (_toolName, result) => fileGlobResultHints(result),
    file_grep: (_toolName, result) => fileGrepResultHints(result),
    file_read: (_toolName, result) => fileReadResultHints(result),
};

const fileTools = new Set(["file_read", "file_edit", "file_glob", "file_grep"]);

const artifactControlTools = new Set(["artifact_viewImage", "artifact_share"]);
const instanceTools = new Set([
    "instance_list",
    "instance_status",
    "instance_create",
    "instance_stop",
]);

function errorResolverFor(toolName: string): ErrorResolver | undefined {
    if (toolName === "bash_run") return (_name, body) => [...bashErrorHints(body), ...processErrorHints(body)];
    if (["task_read", "task_input", "task_inspect", "task_manage"].includes(toolName))
        return (_name, body) => processErrorHints(body);
    if (fileTools.has(toolName))
        return (name, body) => fileErrorHints(name, body);
    if (artifactControlTools.has(toolName))
        return (_name, body) => artifactControlErrorHints(body);
    if (instanceTools.has(toolName))
        return (_name, body) => instanceErrorHints(body);
    return undefined;
}

export function resolveResultHints(
    toolName: string,
    result: JsonValue,
): ToolDiagnosticHint[] {
    const resolver = resultResolvers[toolName];
    return resolver === undefined ? [] : resolver(toolName, result);
}

export function resolveErrorHints(
    toolName: string,
    body: RemoteErrorBody,
): ToolDiagnosticHint[] {
    const resolver = errorResolverFor(toolName);
    const hints: ToolDiagnosticHint[] = [
        ...(resolver === undefined ? [] : resolver(toolName, body)),
        ...crossToolErrorHints(body),
    ];
    if (hints.length === 0) {
        hints.push(
            errorHint("error.unknown", "Inspect the error before retrying."),
        );
    }
    return hints;
}

export function resolveToolCallHints(
    input: ToolCallRewriteInvocation,
): ToolDiagnosticHint[] {
    if (input.direction !== "outbound") return [];
    if (input.value.kind === "result")
        return resolveResultHints(
            input.value.toolName,
            input.value.payload as JsonValue,
        );
    if (input.value.kind !== "error") return [];
    const body = readErrorBody(input.value.payload as JsonValue);
    return body === undefined
        ? []
        : resolveErrorHints(input.value.toolName, body);
}

function readErrorBody(value: JsonValue): RemoteErrorBody | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const error = value.error;
    if (typeof error !== "object" || error === null || Array.isArray(error))
        return undefined;
    if (
        typeof error.code !== "string" ||
        typeof error.message !== "string" ||
        typeof error.retryable !== "boolean"
    ) {
        return undefined;
    }
    return error as unknown as RemoteErrorBody;
}
