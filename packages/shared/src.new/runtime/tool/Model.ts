// Tool definitions and tool-call records. Tool definitions come from the
// target worker; tool-call records are the instance-scoped execution ledger.

import type { InstanceName } from "../identity/Model.js";
import type { JsonValue } from "../../transport/primitive/JsonValue.js";

export const bootstrapToolNamespace = "environ" as const;

export function toolNamespace(name: string): string | undefined {
    const separator = name.indexOf("_");
    if (
        separator <= 0 ||
        separator === name.length - 1 ||
        name.indexOf("_", separator + 1) !== -1
    ) {
        return undefined;
    }
    const namespace = name.slice(0, separator);
    const operation = name.slice(separator + 1);
    return /^[a-z0-9]+$/u.test(namespace) && /^[A-Za-z0-9]+$/u.test(operation)
        ? namespace
        : undefined;
}

export type ToolCapability = "read" | "write" | "execute" | "manage";

export interface ToolDefinition {
    _meta?: JsonValue;
    description: string;
    group: string;
    inputSchema: JsonValue;
    name: string;
    outputSchema: JsonValue;
    requiredCapabilities: readonly ToolCapability[];
}

export interface ToolSessionOpenResult {
    tools: ToolDefinition[];
    workspace: string;
}

export type ToolCallSource = "cli" | "tui" | "web" | "mcp" | "extension";

export interface ToolCallContext {
    requestId?: string;
    operationId?: string;
    ctxId?: string;
    workspace?: string;
    source: ToolCallSource;
}

export interface ToolCallProvenance {
    explanation?: string;
    purpose?: string;
}

export type ToolCallStatus =
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "denied"
    | "queueTimeout"
    | "cancelled";

export type ToolCallFailureStage = "postExecution" | "outboundHook";

export interface ToolCallQuery {
    after?: string;
    before?: string;
    callIds?: string[];
    ctxId?: string;
    includeInput?: boolean;
    includeOutput?: boolean;
    limit?: number;
    maxBytes?: number;
    source?: ToolCallSource;
    status?: ToolCallStatus;
    toolName?: string;
    workspace?: string;
}

export interface ToolCallRecord extends ToolCallProvenance {
    callId: string;
    completedAt?: string;
    error?: string;
    executionCompleted?: boolean;
    exitCode?: number | null;
    failureStage?: ToolCallFailureStage;
    inputSummary: string;
    input?: JsonValue;
    output?: JsonValue;
    instance: InstanceName;
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

export type ToolTermination = "exited" | "signaled" | "timeout";

export function isToolCallEvent(type: string): boolean {
    return type.startsWith("toolCall.");
}
