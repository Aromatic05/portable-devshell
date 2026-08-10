import type { JsonValue, ToolCallContext, ToolDefinition } from "@portable-devshell/shared";

import type { McpInstanceGateway } from "../../instance/McpInstanceGateway.js";
import type { McpEndpointCatalog } from "../McpEndpointCatalog.js";
import { readMcpRoutedInput } from "../McpEndpointInput.js";
import type { McpEndpointWorkerPort } from "../McpEndpointPort.js";
import { mcpEndpointToolNotExposed, requireMcpEndpointGateway, waitForMcpEndpointReady, waitForMcpGatewayReady } from "./McpEndpointHandlerSupport.js";

export class McpEndpointHandlerWorker {
    constructor(private readonly options: {
        catalog: McpEndpointCatalog;
        gateway?: McpInstanceGateway;
        instanceName: string;
        readyWaitMs?: number;
        worker: McpEndpointWorkerPort;
    }) {}

    async call(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        selected: ToolDefinition | undefined,
        instanceRoutingEnabled: boolean,
        signal?: AbortSignal,
        transformResult?: (result: JsonValue, callId: string) => Promise<JsonValue>
    ): Promise<JsonValue> {
        const routed = readMcpRoutedInput(input, instanceRoutingEnabled, this.options.instanceName);
        if (routed.instance === this.options.instanceName) {
            await waitForMcpEndpointReady(
                this.options.worker,
                this.options.instanceName,
                signal,
                { timeoutMs: this.options.readyWaitMs }
            );
            if (selected === undefined) {
                throw mcpEndpointToolNotExposed(toolName, this.options.instanceName);
            }
            this.options.catalog.assertAdaptable(selected);
            return await this.options.worker.callTool(toolName, routed.input, context, signal, transformResult);
        }

        const gateway = requireMcpEndpointGateway(this.options.gateway, this.options.instanceName);
        await waitForMcpGatewayReady(gateway, routed.instance, signal, { timeoutMs: this.options.readyWaitMs });
        const targetTool = gateway.listTools(routed.instance).find((tool) => tool.name === toolName);
        if (targetTool === undefined || !this.options.catalog.isAllowed(targetTool)) {
            throw mcpEndpointToolNotExposed(toolName, routed.instance);
        }
        this.options.catalog.assertAdaptable(targetTool);
        return await gateway.callTool(routed.instance, toolName, routed.input, context, signal, transformResult);
    }
}
