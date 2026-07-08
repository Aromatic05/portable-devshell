import type { CliControlClientLike } from "../../control/CliControlClient.js";
import type { CliControlStream } from "../../control/CliControlStream.js";
import type { CliInstanceSnapshotEnvelope } from "../../control/CliControlStream.js";

export class CliCommandWatchStatus {
    async execute(
        client: CliControlClientLike,
        instance: string,
        onSnapshot: (snapshot: CliInstanceSnapshotEnvelope["snapshot"]) => Promise<void> | void,
        maxEvents?: number
    ): Promise<void> {
        let handled = 0;
        let stream: CliControlStream | undefined;

        try {
            while (true) {
                if (stream === undefined) {
                    const snapshot = await client.getSnapshot(instance);
                    await onSnapshot(snapshot.snapshot);

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
                const refreshed = await client.refreshStatus(instance);
                await onSnapshot(refreshed.snapshot);
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
