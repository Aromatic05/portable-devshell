import type { InstanceSnapshot } from "@portable-devshell/shared";

import type { CliClientRuntime } from "../../../transport/Runtime.js";
import { followCliCommandWatchStream } from "./Stream.js";

export class CliCommandWatchStatus {
    async execute(
        runtime: CliClientRuntime,
        instance: string,
        onSnapshot: (snapshot: InstanceSnapshot) => Promise<void> | void,
        maxEvents?: number,
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
            subscribe: (fromSeq) => runtime.subscribe(instance, fromSeq),
        });
    }
}

import type { CliParsedCommand } from "../../Parse.js";
import type { CliDispatchContext } from "../../Dispatch.js";
import { renderInstanceSnapshot } from "../lifecycle/Render.js";
export async function executeWatchStatus(
    command: CliParsedCommand,
    context: CliDispatchContext,
): Promise<boolean> {
    if (command.kind !== "watch.status") return false;
    await new CliCommandWatchStatus().execute(
        context.clients.runtime,
        command.instance,
        async (snapshot) =>
            context.stdout.write(renderInstanceSnapshot(snapshot)),
        context.followEventLimit,
    );
    return true;
}
