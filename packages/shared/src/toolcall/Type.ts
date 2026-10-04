import type { InstanceName } from "../types/Instance.js";
import type { JsonValue } from "../types/Json.js";

type ToolCapability = "read" | "write" | "execute" | "manage";
type ToolCallSource = "cli" | "tui" | "web" | "mcp" | "extension";
type ToolCallStatus =
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "denied"
    | "queueTimeout"
    | "cancelled";
type ToolCallFailureStage = "postExecution" | "outboundHook";
type ToolTermination = "exited" | "signaled" | "timeout";

export interface ToolDefinition {
    _meta?: JsonValue;
    description: string;
    group: string;
    inputSchema: JsonValue;
    name: string;
    outputSchema: JsonValue;
    requiredCapabilities: readonly ToolCapability[];
}

export interface ToolCallExternalBinding {
    kind: string;
    value: string;
}

export interface ToolCallContext {
    requestId?: string;
    operationId?: string;
    ctxId?: string;
    workspace?: string;
    principal?: string;
    externalBindings?: readonly ToolCallExternalBinding[];
    contextMode?: "explicit" | "openai-session";
    source: ToolCallSource;
}

export type ToolCallHookKind = "call" | "error" | "progress" | "result";
export type ToolCallHookContext = ToolCallContext & { instance: InstanceName };

export type ToolCallPresentationContent =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mediaType: string };

export interface ToolCallPresentation {
    content?: readonly ToolCallPresentationContent[];
    isError?: boolean;
}

export interface ToolCallHookValue {
    context: ToolCallHookContext;
    kind: ToolCallHookKind;
    payload: JsonValue;
    toolName: string;
}

export interface ToolCallRecord {
    callId: string;
    completedAt?: string;
    error?: string;
    executionCompleted?: boolean;
    exitCode?: number | null;
    explanation?: string;
    failureStage?: ToolCallFailureStage;
    inputSummary: string;
    input?: JsonValue;
    output?: JsonValue;
    instance: InstanceName;
    purpose?: string;
    requestId?: string;
    ctxId?: string;
    source: ToolCallSource;
    startedAt: string;
    status: ToolCallStatus;
    stderrBytes?: number;
    stdoutBytes?: number;
    termSignal?: number;
    termination?: ToolTermination;
    toolName: string;
    workspace?: string;
}
