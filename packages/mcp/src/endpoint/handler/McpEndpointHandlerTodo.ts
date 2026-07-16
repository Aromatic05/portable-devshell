import type { JsonValue, ToolCallContext } from "@portable-devshell/shared";

import type { McpInstanceGateway } from "../../instance/McpInstanceGateway.js";
import type { McpToolCatalogTodoName } from "../../tool/catalog/McpToolCatalogTodo.js";
import { waitForMcpEndpointAbortable } from "../McpEndpointCancellation.js";
import { assertMcpNoArguments } from "../McpEndpointInput.js";
import { requireMcpEndpointGateway } from "./McpEndpointHandlerSupport.js";

export class McpEndpointHandlerTodo {
    constructor(private readonly options: { gateway?: McpInstanceGateway; instanceName: string }) {}

    async call(toolName: McpToolCatalogTodoName, input: JsonValue, context: ToolCallContext, signal?: AbortSignal): Promise<JsonValue> {
        const gateway = requireMcpEndpointGateway(this.options.gateway, this.options.instanceName);
        switch (toolName) {
            case "todo_read":
                assertMcpNoArguments(input, toolName);
                return await waitForMcpEndpointAbortable(gateway.readTodo(this.options.instanceName), signal);
            case "todo_write":
                return await waitForMcpEndpointAbortable(gateway.writeTodo(this.options.instanceName, input, context), signal);
        }
    }
}
