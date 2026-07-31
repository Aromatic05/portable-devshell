import type { JsonValue, ToolCallContext } from "@portable-devshell/shared";

import type { McpInstanceGateway } from "../../instance/McpInstanceGateway.js";
import type { McpToolCatalogContextMessageName } from "../../tool/catalog/McpToolCatalogContextMessage.js";
import { waitForMcpEndpointAbortable } from "../McpEndpointCancellation.js";
import { requireMcpEndpointGateway } from "./McpEndpointHandlerSupport.js";

export class McpEndpointHandlerContextMessage {
    constructor(private readonly options: { gateway?: McpInstanceGateway; instanceName: string }) {}

    async call(toolName: McpToolCatalogContextMessageName, input: JsonValue, context: ToolCallContext, signal?: AbortSignal): Promise<JsonValue> {
        if (toolName !== "context_message_read" || !isEmptyObject(input)) {
            throw new Error("context_message_read requires an empty object input.");
        }
        if (context.ctxId === undefined || context.ctxId.length === 0) {
            throw new Error("context_message_read requires a validated ctxId.");
        }
        const gateway = requireMcpEndpointGateway(this.options.gateway, this.options.instanceName);
        if (gateway.readContextMessages === undefined) {
            throw new Error("Context message service is unavailable.");
        }
        return await waitForMcpEndpointAbortable(
            gateway.readContextMessages(this.options.instanceName, context.ctxId),
            signal
        );
    }
}

function isEmptyObject(value: JsonValue): boolean {
    return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}
