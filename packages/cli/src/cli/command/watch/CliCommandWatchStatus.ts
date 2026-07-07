import type { CliControlClientLike } from "../../control/CliControlClient.js";
import type { CliInstanceSnapshotEnvelope } from "../../control/CliControlStream.js";

export class CliCommandWatchStatus {
    async execute(
        client: CliControlClientLike,
        instance: string,
        onSnapshot: (snapshot: CliInstanceSnapshotEnvelope["snapshot"]) => Promise<void> | void,
        maxEvents?: number
    ): Promise<void> {
        const initial = await client.getSnapshot(instance);
        await onSnapshot(initial.snapshot);

        const stream = await client.subscribe(instance, initial.lastSeq + 1);

        try {
            let handled = 0;

            while (maxEvents === undefined || handled < maxEvents) {
                await stream.nextEvent();
                handled += 1;
                const refreshed = await client.refreshStatus(instance);
                await onSnapshot(refreshed.snapshot);
            }
        } finally {
            stream.close();
        }
    }
}
