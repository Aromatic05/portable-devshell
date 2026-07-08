import type { CliControlClientLike } from "../../control/CliControlClient.js";
import type { CliControlStream, CliInstanceLogEntry } from "../../control/CliControlStream.js";

export class CliCommandWatchLogs {
    async execute(
        client: CliControlClientLike,
        instance: string,
        onEntries: (entries: CliInstanceLogEntry[]) => Promise<void> | void,
        maxEvents?: number
    ): Promise<void> {
        let handled = 0;
        let nextLogSeq = 1;
        let stream: CliControlStream | undefined;

        try {
            while (true) {
                if (stream === undefined) {
                    const snapshot = await client.getSnapshot(instance);
                    const initialLogs = await client.readLogs(instance, { fromSeq: nextLogSeq });

                    if (initialLogs.length > 0) {
                        nextLogSeq = initialLogs.at(-1)!.seq + 1;
                        await onEntries(initialLogs);
                    }

                    try {
                        stream = await client.subscribe(instance, snapshot.lastSeq + 1);
                    } catch (error) {
                        if (readErrorCode(error) === "stream.gap") {
                            continue;
                        }

                        throw error;
                    }
                }

                if (maxEvents !== undefined && handled >= maxEvents) {
                    return;
                }

                try {
                    await stream.nextEvent();
                } catch (error) {
                    stream.close();
                    stream = undefined;

                    if (readErrorCode(error) === "stream.gap") {
                        continue;
                    }

                    throw error;
                }

                handled += 1;
                const entries = await client.readLogs(instance, { fromSeq: nextLogSeq });

                if (entries.length > 0) {
                    nextLogSeq = entries.at(-1)!.seq + 1;
                    await onEntries(entries);
                }
            }
        } finally {
            stream?.close();
        }
    }
}

function readErrorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
}
