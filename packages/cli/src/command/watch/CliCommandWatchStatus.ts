import type { InstanceSnapshot } from "@portable-devshell/shared";

import type { CliClientRuntime } from "../../client/runtime/CliClientRuntime.js";
import { followCliCommandWatchStream } from "./CliCommandWatchStream.js";

export class CliCommandWatchStatus {
    async execute(
        runtime: CliClientRuntime,
        instance: string,
        onSnapshot: (snapshot: InstanceSnapshot) => Promise<void> | void,
        maxEvents?: number
    ): Promise<void> {
        await followCliCommandWatchStream({
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
