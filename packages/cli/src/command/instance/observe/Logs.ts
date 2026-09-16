import type { InstanceLogEntry } from "@portable-devshell/shared";

import type { CliClientRuntime } from "../../../transport/Runtime.js";
import { followCliCommandWatchStream } from "./Stream.js";

export class CliCommandWatchLogs {
    async execute(
        runtime: CliClientRuntime,
        instance: string,
        onEntries: (entries: InstanceLogEntry[]) => Promise<void> | void,
        maxEvents?: number,
    ): Promise<void> {
        let nextLogSeq = 1;
        const emitNewLogs = async () => {
            const entries = await runtime.readLogs(instance, {
                fromSeq: nextLogSeq,
            });
            if (entries.length > 0) {
                nextLogSeq = entries.at(-1)!.seq + 1;
                await onEntries(entries);
            }
        };
        await followCliCommandWatchStream({
            async loadFromSeq() {
                const snapshot = await runtime.snapshot(instance);
                await emitNewLogs();
                return snapshot.lastSeq + 1;
            },
            maxEvents,
            onEvent: emitNewLogs,
            subscribe: (fromSeq) => runtime.subscribe(instance, fromSeq),
        });
    }
}

export function renderInstanceLogs(
    entries: readonly InstanceLogEntry[],
): string {
    if (entries.length === 0) {
        return "";
    }

    return `${entries.map((entry) => `[${entry.seq}] ${entry.stream} ${entry.message.replace(/\n$/u, "")}`).join("\n")}\n`;
}

import type { CliParsedCommand } from "../../Parse.js";
import type { CliDispatchContext } from "../../Dispatch.js";
export async function executeInstanceLogs(
    command: CliParsedCommand,
    context: CliDispatchContext,
): Promise<boolean> {
    if (command.kind !== "instance.logs" && command.kind !== "watch.logs")
        return false;
    const follow = command.kind === "watch.logs" ? true : command.follow;
    if (follow) {
        context.requireStreamingOutput(
            command.kind === "watch.logs"
                ? "watch logs"
                : "instance logs --follow",
        );
        await new CliCommandWatchLogs().execute(
            context.clients.runtime,
            command.instance,
            async (entries) =>
                context.writeRecords(entries, renderInstanceLogs(entries)),
            context.followEventLimit,
        );
    } else {
        const entries = await context.clients.runtime.readLogs(
            command.instance,
        );
        context.writeRecords(entries, renderInstanceLogs(entries));
    }
    return true;
}
