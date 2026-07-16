import type { InstanceLogEntry } from "@portable-devshell/shared";

import type { RuntimeClient } from "../../modules/runtime/RuntimeClient.js";
import { followControlStream } from "./CliCommandFollowStream.js";

export class CliCommandWatchLogs {
    async execute(
        runtime: RuntimeClient,
        instance: string,
        onEntries: (entries: InstanceLogEntry[]) => Promise<void> | void,
        maxEvents?: number
    ): Promise<void> {
        let nextLogSeq = 1;
        const emitNewLogs = async () => {
            const entries = await runtime.readLogs(instance, { fromSeq: nextLogSeq });
            if (entries.length > 0) {
                nextLogSeq = entries.at(-1)!.seq + 1;
                await onEntries(entries);
            }
        };
        await followControlStream({
            async loadFromSeq() {
                const snapshot = await runtime.snapshot(instance);
                await emitNewLogs();
                return snapshot.lastSeq + 1;
            },
            maxEvents,
            onEvent: emitNewLogs,
            subscribe: (fromSeq) => runtime.subscribe(instance, fromSeq)
        });
    }
}
