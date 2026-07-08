import type { CliControlClientLike } from "../../control/CliControlClient.js";
import type { CliControlStream, CliInstanceLogEntry } from "../../control/CliControlStream.js";

export class CliCommandWatchLogs {
    async execute(
        client: CliControlClientLike,
        instance: string,
        onEntries: (entries: CliInstanceLogEntry[]) => Promise<void> | void,
        maxEvents?: number
    ): Promise<void> {
        const snapshot = await client.getSnapshot(instance);
        const initialLogs = await client.readLogs(instance);
        let nextLogSeq = (initialLogs.at(-1)?.seq ?? 0) + 1;
        await onEntries(initialLogs);
        const stream = await client.subscribe(instance, snapshot.lastSeq + 1);

        try {
            let handled = 0;

            while (maxEvents === undefined || handled < maxEvents) {
                await stream.nextEvent();
                handled += 1;
                const entries = await client.readLogs(instance, { fromSeq: nextLogSeq });

                if (entries.length > 0) {
                    nextLogSeq = entries.at(-1)!.seq + 1;
                    await onEntries(entries);
                }
            }
        } finally {
            stream.close();
        }
    }
}
