import type { CliControlClientLike } from "../../control/CliControlClient.js";
import type { CliInstanceSnapshotEnvelope } from "../../control/CliControlStream.js";

export class CliCommandInstanceStatus {
    async execute(client: CliControlClientLike, instance: string): Promise<CliInstanceSnapshotEnvelope> {
        return await client.getSnapshot(instance);
    }
}
