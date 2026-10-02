import type { ToolCallHookValue } from "@portable-devshell/core";
import type { JsonValue, ToolCallContext } from "@portable-devshell/shared";
import type { McpInstanceGateway } from "../../Port.js";
import { readMcpRoutedInput } from "../../dispatch/Input.js";
import { requireMcpEndpointGateway } from "../../dispatch/Support.js";

export class McpEndpointHandlerWorker {
    constructor(private readonly options: {
        gateway?: McpInstanceGateway;
        instanceName: string;
    }) {}

    async call(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        instanceRoutingEnabled: boolean,
        signal: AbortSignal | undefined,
        transformResult: (result: JsonValue, callId: string) => Promise<JsonValue>,
        invocationInput: (input: JsonValue, callId: string, finalValue: ToolCallHookValue) => Promise<JsonValue>,
    ): Promise<JsonValue> {
        const routed = readMcpRoutedInput(input, instanceRoutingEnabled, this.options.instanceName);
        return await requireMcpEndpointGateway(this.options.gateway, this.options.instanceName).callTool(
            routed.instance, toolName, routed.input, context, signal, transformResult, invocationInput,
        );
    }
}
