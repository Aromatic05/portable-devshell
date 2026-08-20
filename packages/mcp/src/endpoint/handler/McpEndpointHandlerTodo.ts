import type { JsonValue, TodoReadInput, ToolCallContext } from "@portable-devshell/shared";

import type { McpContextSelector } from "../../context/McpContextSelector.js";
import type { McpInstanceGateway } from "../../instance/McpInstanceGateway.js";
import type { McpToolCatalogTodoName } from "../../tool/catalog/McpToolCatalogTodo.js";
import { waitForMcpEndpointAbortable } from "../McpEndpointCancellation.js";
import { requireMcpEndpointGateway } from "./McpEndpointHandlerSupport.js";

export class McpEndpointHandlerTodo {
    constructor(private readonly options: {
        contextSelector: McpContextSelector;
        gateway?: McpInstanceGateway;
        instanceName: string;
    }) {}

    async call(toolName: McpToolCatalogTodoName, input: JsonValue, context: ToolCallContext, signal?: AbortSignal): Promise<JsonValue> {
        const gateway = requireMcpEndpointGateway(this.options.gateway, this.options.instanceName);
        switch (toolName) {
            case "todo_read": {
                const selector = readTodoInput(input);
                if (!this.options.contextSelector.requiresExplicitContextId && selector?.title !== undefined) {
                    throw new Error("todo_read title selection is unavailable in host-session context mode; use taskId for explicit durable handoff.");
                }
                const result = await waitForMcpEndpointAbortable(
                    gateway.readTodo(this.options.instanceName, selector),
                    signal
                );
                return this.options.contextSelector.requiresExplicitContextId
                    ? result
                    : projectSessionTodoResult(result, selector, context.ctxId);
            }
            case "todo_write": {
                if (!this.options.contextSelector.requiresExplicitContextId) {
                    assertSessionTodoWrite(input);
                }
                const result = await waitForMcpEndpointAbortable(
                    gateway.writeTodo(this.options.instanceName, input, context),
                    signal
                );
                return this.options.contextSelector.requiresExplicitContextId
                    ? result
                    : projectSessionTodoResult(result, undefined, context.ctxId);
            }
        }
    }
}

function projectSessionTodoResult(
    result: JsonValue,
    selector: TodoReadInput | undefined,
    ctxId: string | undefined
): JsonValue {
    if (ctxId === undefined || !isRecord(result) || !Array.isArray(result.tasks)) return result;
    const tasks = result.tasks.flatMap((task) => {
        if (!isRecord(task)) return [];
        const selected = selector?.taskId === task.taskId;
        if (task.ctxId !== ctxId && !selected) return [];
        const { ctxId: _ctxId, ...visible } = task;
        return [visible as JsonValue];
    });
    return { ...result, tasks };
}

function readTodoInput(input: JsonValue): TodoReadInput | undefined {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("todo_read requires an object input.");
    }
    const keys = Object.keys(input);
    if (keys.length === 0) return undefined;
    if (keys.length !== 1 || (keys[0] !== "taskId" && keys[0] !== "title")) {
        throw new Error("todo_read accepts only one optional selector: taskId or title.");
    }
    const key = keys[0] as "taskId" | "title";
    const value = input[key];
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`todo_read ${key} must be a non-empty string.`);
    }
    return { [key]: value.trim() };
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSessionTodoWrite(input: JsonValue): void {
    if (!isRecord(input)) return;
    if (input.taskId !== undefined || input.revision === 0) return;
    throw new Error("todo_write updates in host-session context mode require taskId; omit taskId only when creating revision 0.");
}
