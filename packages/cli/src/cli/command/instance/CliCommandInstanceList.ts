import type { CliControlClientLike } from "../../control/CliControlClient.js";
import type { CliInstanceListEntry } from "../../control/CliControlStream.js";

export class CliCommandInstanceList {
    async execute(client: CliControlClientLike): Promise<CliInstanceListEntry[]> {
        return await client.listInstances();
    }
}
