import type { McpEndpointBinding } from "../McpEndpointBinding.js";

type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

export interface McpResponseEnvelope {
    error?: {
        code: number;
        data?: JsonValue;
        message: string;
    };
    id: JsonValue;
    jsonrpc: "2.0";
    result?: JsonValue;
}

export class McpEndpointHandlerInitialize {
    handle(binding: McpEndpointBinding, id: JsonValue): McpResponseEnvelope {
        const session = binding.createSession();
        session.initialize();

        return {
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: "2026-07-07",
                serverInfo: {
                    name: "portable-devshell-mcp",
                    version: "0.0.0"
                },
                capabilities: {
                    tools: {}
                },
                sessionId: session.id
            }
        };
    }
}
