// Tool definitions and tool-call records. Tool definitions come from the
// target worker; tool-call records are the instance-scoped execution ledger.

import type { InstanceName } from "../../types/Instance.js";
import type { JsonValue } from "../../types/Json.js";

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
type ParseSuccess<T> = { data: T; success: true };
type ParseFailure = { error: Error; success: false };
type ParseResult<T> = ParseFailure | ParseSuccess<T>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolCapability(value: unknown): value is ToolCapability {
    return (
        value === "read" ||
        value === "write" ||
        value === "execute" ||
        value === "manage"
    );
}

function parseRequiredCapabilities(value: unknown): ToolCapability[] {
    if (!Array.isArray(value))
        throw new Error("tool.requiredCapabilities must be an array");
    const capabilities: ToolCapability[] = [];
    const seen = new Set<ToolCapability>();
    for (const capability of value) {
        if (!isToolCapability(capability)) {
            throw new Error(
                "tool.requiredCapabilities contains an invalid capability",
            );
        }
        if (seen.has(capability)) {
            throw new Error(
                `tool.requiredCapabilities contains duplicate capability: ${capability}`,
            );
        }
        seen.add(capability);
        capabilities.push(capability);
    }
    return capabilities;
}

export const toolSchema = {
    parse(value: unknown): ToolDefinition {
        if (!isRecord(value))
            throw new Error("tool definition must be an object");
        if (typeof value.name !== "string" || value.name.length === 0) {
            throw new Error("tool.name must be a non-empty string");
        }
        const namespace = toolNamespace(value.name);
        if (namespace === undefined)
            throw new Error("tool.name must use namespace_operation form");
        if (typeof value.description !== "string")
            throw new Error("tool.description must be a string");
        if (typeof value.group !== "string" || value.group.length === 0)
            throw new Error("tool.group must be a non-empty string");
        if (value.group !== namespace) {
            throw new Error(
                `tool.group ${value.group} must match namespace ${namespace} from tool.name ${value.name}`,
            );
        }
        if (!isRecord(value.inputSchema) || !isRecord(value.outputSchema)) {
            throw new Error("tool schemas must be JSON objects");
        }
        return {
            description: value.description,
            group: value.group,
            inputSchema: value.inputSchema as JsonValue,
            name: value.name,
            outputSchema: value.outputSchema as JsonValue,
            requiredCapabilities: parseRequiredCapabilities(
                value.requiredCapabilities,
            ),
        };
    },
    safeParse(value: unknown): ParseResult<ToolDefinition> {
        try {
            return { data: this.parse(value), success: true };
        } catch (error) {
            return {
                error:
                    error instanceof Error ? error : new Error(String(error)),
                success: false,
            };
        }
    },
};
