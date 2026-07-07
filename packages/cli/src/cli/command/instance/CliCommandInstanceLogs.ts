import type { CliControlClientLike } from "../../control/CliControlClient.js";
import type { CliInstanceLogEntry } from "../../control/CliControlStream.js";

export class CliCommandInstanceLogs {
    async execute(client: CliControlClientLike, instance: string): Promise<CliInstanceLogEntry[]> {
        return await client.readLogs(instance);
    }
}
