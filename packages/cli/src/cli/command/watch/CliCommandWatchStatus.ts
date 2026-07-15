import type { CliControlClientLike } from "../../control/CliControlClient.js";
import type { CliInstanceSnapshotEnvelope } from "../../control/CliControlStream.js";
import { followControlStream } from "./CliCommandFollowStream.js";

export class CliCommandWatchStatus {
    async execute(
        client: CliControlClientLike,
        instance: string,
        onSnapshot: (snapshot: CliInstanceSnapshotEnvelope["snapshot"]) => Promise<void> | void,
        maxEvents?: number
    ): Promise<void> {
        await followControlStream({
            async loadFromSeq() {
                const envelope = await client.getSnapshot(instance);
                await onSnapshot(envelope.snapshot);
                return envelope.lastSeq + 1;
            },
            maxEvents,
            async onEvent() {
                await onSnapshot((await client.refreshStatus(instance)).snapshot);
            },
            subscribe: (fromSeq) => client.subscribe(instance, fromSeq)
        });
    }
}
