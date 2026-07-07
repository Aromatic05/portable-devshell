import type { CliControlClientLike } from "../../control/CliControlClient.js";
import type { CliInstanceSnapshotEnvelope } from "../../control/CliControlStream.js";

export class CliCommandInstanceStart {
    async execute(client: CliControlClientLike, instance: string): Promise<CliInstanceSnapshotEnvelope["snapshot"]> {
        return await client.startInstance(instance);
    }
}
