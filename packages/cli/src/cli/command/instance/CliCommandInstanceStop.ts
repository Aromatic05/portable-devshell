import type { CliControlClientLike } from "../../control/CliControlClient.js";
import type { CliInstanceSnapshotEnvelope } from "../../control/CliControlStream.js";

export class CliCommandInstanceStop {
    async execute(client: CliControlClientLike, instance: string): Promise<CliInstanceSnapshotEnvelope["snapshot"]> {
        return await client.stopInstance(instance);
    }
}
