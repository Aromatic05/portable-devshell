import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

import type { AgentWorkerClient } from "../AgentProvider.js";

export interface PiWorkerTool {
    description: string;
    execute(
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal
    ): Promise<{
        content: Array<{ text: string; type: "text" }>;
        details: JsonValue;
    }>;
    label: string;
    name: string;
    parameters: JsonValue;
}

export type PiWorkerToolExecutor = (
    toolCallId: string,
    definition: ToolDefinition,
    input: JsonValue,
    signal?: AbortSignal
) => Promise<JsonValue>;

export async function createPiWorkerTools(worker: AgentWorkerClient): Promise<PiWorkerTool[]> {
    const definitions = await worker.listTools();
    return createPiWorkerToolsFromDefinitions(
        definitions,
        async (toolCallId, definition, input, signal) => await worker.callTool(
            definition.name,
            input,
            { operationId: toolCallId, signal }
        )
    );
}

export function createPiWorkerToolsFromDefinitions(
    definitions: readonly ToolDefinition[],
    execute: PiWorkerToolExecutor
): PiWorkerTool[] {
    return definitions.map((definition) => toPiWorkerTool(definition, execute));
}

function toPiWorkerTool(definition: ToolDefinition, execute: PiWorkerToolExecutor): PiWorkerTool {
    return {
        description: definition.description,
        async execute(toolCallId, params, signal) {
            const result = await execute(toolCallId, definition, asJsonValue(params), signal);
            return {
                content: [{ text: renderToolResult(result), type: "text" }],
                details: result
            };
        },
        label: definition.name,
        name: definition.name,
        parameters: definition.inputSchema
    };
}

function asJsonValue(value: unknown): JsonValue {
    if (!isJsonValue(value)) {
        throw new TypeError("Pi tool arguments are not JSON serializable.");
    }
    return value;
}

function isJsonValue(value: unknown): value is JsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return true;
    }
    if (typeof value === "number") {
        return Number.isFinite(value);
    }
    if (Array.isArray(value)) {
        return value.every(isJsonValue);
    }
    if (typeof value !== "object") {
        return false;
    }
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function renderToolResult(value: JsonValue): string {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
