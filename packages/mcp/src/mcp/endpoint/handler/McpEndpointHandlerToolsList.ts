import type { McpEndpointBinding } from "../McpEndpointBinding.js";
import type { McpResponseEnvelope } from "./McpEndpointHandlerInitialize.js";

type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

export class McpEndpointHandlerToolsList {
    handle(binding: McpEndpointBinding, id: JsonValue): McpResponseEnvelope {
        return {
            jsonrpc: "2.0",
            id,
            result: {
                tools: binding.worker.listTools()
            } as JsonValue
        };
    }
}
