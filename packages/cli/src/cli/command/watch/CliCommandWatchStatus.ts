import type { InstanceSnapshot } from "@portable-devshell/shared";

import type { RuntimeClient } from "../../modules/runtime/RuntimeClient.js";
import { followControlStream } from "./CliCommandFollowStream.js";

export class CliCommandWatchStatus {
    async execute(
        runtime: RuntimeClient,
        instance: string,
        onSnapshot: (snapshot: InstanceSnapshot) => Promise<void> | void,
        maxEvents?: number
    ): Promise<void> {
        await followControlStream({
            async loadFromSeq() {
                const envelope = await runtime.snapshot(instance);
                await onSnapshot(envelope.snapshot);
                return envelope.lastSeq + 1;
            },
            maxEvents,
            async onEvent() {
                await onSnapshot((await runtime.refresh(instance)).snapshot);
            },
            subscribe: (fromSeq) => runtime.subscribe(instance, fromSeq)
        });
    }
}
