// Tool wire contract. call/callStream are Control-port operations that route
// through the shared tool-call pipeline; session and call-history operations
// are instance-port reads.

import type { JsonValue } from "../../transport/primitive/JsonValue.js";
import {
    toolNamespace,
    type ToolCallQuery,
    type ToolCallRecord,
    type ToolCapability,
    type ToolDefinition,
    type ToolSessionOpenResult,
} from "./Model.js";

export const toolOperations = {
    call: "call",
    callStream: "callStream",
    closeSession: "closeSession",
    listCalls: "listCalls",
    openSession: "openSession",
} as const;

export interface ToolContract {
    call: {
        request: {
            instance: string;
            toolName: string;
            input: JsonValue;
            workspace: string;
        };
        response: JsonValue;
    };
    closeSession: {
        request: Record<string, never>;
        response: Record<string, never>;
    };
    listCalls: {
        request: ToolCallQuery | undefined;
        response: ToolCallRecord[];
    };
    openSession: {
        request: { workspace: string };
        response: ToolSessionOpenResult;
    };
}

export type ToolOperation = keyof ToolContract;

export type ToolRequest<Operation extends ToolOperation> =
    ToolContract[Operation]["request"];

export type ToolResponse<Operation extends ToolOperation> =
    ToolContract[Operation]["response"];

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
