import type { JsonValue, TodoReadInput, ToolCallContext } from "@portable-devshell/shared";

import type { McpInstanceGateway } from "../../instance/McpInstanceGateway.js";
import type { McpToolCatalogTodoName } from "../../tool/catalog/McpToolCatalogTodo.js";
import { waitForMcpEndpointAbortable } from "../McpEndpointCancellation.js";
import { requireMcpEndpointGateway } from "./McpEndpointHandlerSupport.js";

export class McpEndpointHandlerTodo {
    constructor(private readonly options: { gateway?: McpInstanceGateway; instanceName: string }) {}

    async call(toolName: McpToolCatalogTodoName, input: JsonValue, context: ToolCallContext, signal?: AbortSignal): Promise<JsonValue> {
        const gateway = requireMcpEndpointGateway(this.options.gateway, this.options.instanceName);
        switch (toolName) {
            case "todo_read":
                return await waitForMcpEndpointAbortable(
                    gateway.readTodo(this.options.instanceName, readTodoInput(input)),
                    signal
                );
            case "todo_write":
                return await waitForMcpEndpointAbortable(gateway.writeTodo(this.options.instanceName, input, context), signal);
        }
    }
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
