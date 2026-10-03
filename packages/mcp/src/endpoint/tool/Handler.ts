import type { ToolCallHookValue } from "@portable-devshell/core";
import type { JsonValue, ToolCallContext } from "@portable-devshell/shared";
import type { McpInstanceGateway } from "../../instance/Gateway.js";
import { readMcpRoutedInput } from "./Input.js";
import { requireMcpEndpointGateway } from "../call/Boundary.js";

export class McpEndpointHandlerTool {
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
