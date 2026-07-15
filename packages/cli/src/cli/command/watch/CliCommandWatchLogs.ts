import type { CliControlClientLike } from "../../control/CliControlClient.js";
import type { CliInstanceLogEntry } from "../../control/CliControlStream.js";
import { followControlStream } from "./CliCommandFollowStream.js";

export class CliCommandWatchLogs {
    async execute(
        client: CliControlClientLike,
        instance: string,
        onEntries: (entries: CliInstanceLogEntry[]) => Promise<void> | void,
        maxEvents?: number
    ): Promise<void> {
        let nextLogSeq = 1;
        const emitNewLogs = async () => {
            const entries = await client.readLogs(instance, { fromSeq: nextLogSeq });
            if (entries.length > 0) {
                nextLogSeq = entries.at(-1)!.seq + 1;
                await onEntries(entries);
            }
        };

        await followControlStream({
            async loadFromSeq() {
                const snapshot = await client.getSnapshot(instance);
                await emitNewLogs();
                return snapshot.lastSeq + 1;
            },
            maxEvents,
            onEvent: emitNewLogs,
            subscribe: (fromSeq) => client.subscribe(instance, fromSeq)
        });
    }
}
