import type { JsonValue } from "@portable-devshell/shared";

import type { CliControlClientLike } from "../../control/CliControlClient.js";
export class CliCommandInstanceCall {
    async execute(client: CliControlClientLike, instance: string, toolName: string, input: JsonValue): Promise<JsonValue> {
        return await client.callTool(instance, toolName, input);
    }
}
