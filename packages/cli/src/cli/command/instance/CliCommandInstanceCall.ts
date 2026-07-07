import type { JsonValue } from "@portable-devshell/shared";

import type { CliControlClientLike } from "../../control/CliControlClient.js";
import type { CliCommandResult } from "../../control/CliControlStream.js";

export class CliCommandInstanceCall {
    async execute(client: CliControlClientLike, instance: string, toolName: string, input: JsonValue): Promise<CliCommandResult> {
        return await client.callTool(instance, toolName, input);
    }
}
