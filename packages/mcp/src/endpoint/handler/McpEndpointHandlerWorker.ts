import type { JsonValue, ToolCallContext, ToolDefinition } from "@portable-devshell/shared";

import type { McpInstanceGateway } from "../../instance/McpInstanceGateway.js";
import type { McpEndpointCatalog } from "../McpEndpointCatalog.js";
import { readMcpRoutedInput } from "../McpEndpointInput.js";
import type { McpEndpointWorkerPort } from "../McpEndpointPort.js";
import { assertMcpEndpointReady, mcpEndpointToolNotExposed, requireMcpEndpointGateway } from "./McpEndpointHandlerSupport.js";

export class McpEndpointHandlerWorker {
    constructor(private readonly options: {
        catalog: McpEndpointCatalog;
        gateway?: McpInstanceGateway;
        instanceName: string;
        worker: McpEndpointWorkerPort;
    }) {}

    async call(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        selected: ToolDefinition | undefined,
        instanceRoutingEnabled: boolean,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        const routed = readMcpRoutedInput(input, instanceRoutingEnabled, this.options.instanceName);
        if (routed.instance === this.options.instanceName) {
            assertMcpEndpointReady(this.options.worker, this.options.instanceName);
            if (selected === undefined) {
                throw mcpEndpointToolNotExposed(toolName, this.options.instanceName);
            }
            this.options.catalog.assertAdaptable(selected);
            return await this.options.worker.callTool(toolName, routed.input, context, signal);
        }

        const gateway = requireMcpEndpointGateway(this.options.gateway, this.options.instanceName);
        gateway.assertReady(routed.instance);
        const targetTool = gateway.listTools(routed.instance).find((tool) => tool.name === toolName);
        if (targetTool === undefined || !this.options.catalog.isAllowed(targetTool)) {
            throw mcpEndpointToolNotExposed(toolName, routed.instance);
        }
        this.options.catalog.assertAdaptable(targetTool);
        return await gateway.callTool(routed.instance, toolName, routed.input, context, signal);
    }
}
