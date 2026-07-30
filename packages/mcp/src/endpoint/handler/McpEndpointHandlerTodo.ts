import type { JsonValue, ToolCallContext } from "@portable-devshell/shared";

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
                    gateway.readTodo(this.options.instanceName, readTodoTitle(input)),
                    signal
                );
            case "todo_write":
                return await waitForMcpEndpointAbortable(gateway.writeTodo(this.options.instanceName, input, context), signal);
        }
    }
}

function readTodoTitle(input: JsonValue): string | undefined {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("todo_read requires an object input.");
    }
    const title = input.title;
    if (title === undefined) return undefined;
    if (typeof title !== "string" || title.trim().length === 0 || Object.keys(input).length !== 1) {
        throw new Error("todo_read accepts only an optional non-empty title.");
    }
    return title.trim();
}
