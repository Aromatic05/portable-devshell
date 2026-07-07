import type { McpEndpointBinding } from "../McpEndpointBinding.js";
import type { McpResponseEnvelope } from "./McpEndpointHandlerInitialize.js";

type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

interface CommandResult {
    exitCode: number | null;
    stderr: string;
    stdout: string;
    timedOut?: boolean;
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class McpEndpointHandlerToolsCall {
    async handle(binding: McpEndpointBinding, id: JsonValue, params: JsonValue): Promise<McpResponseEnvelope> {
        const toolName = isRecord(params) && typeof params.name === "string" ? params.name : "";
        const input = isRecord(params) && params.arguments !== undefined ? params.arguments : {};
        const result: CommandResult = await binding.worker.callTool(toolName, input);

        return {
            jsonrpc: "2.0",
            id,
            result: {
                content: [
                    {
                        type: "text",
                        text: result.stdout
                    }
                ],
                isError: result.exitCode !== 0
            } as JsonValue
        };
    }
}
