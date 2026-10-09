export interface CliRenderedControlStatus {
    instanceCount: number;
    pid?: number;
    running: boolean;
}

export function renderControlStatus(status: CliRenderedControlStatus): string {
    if (!status.running) {
        return "control: stopped\n";
    }

    const lines = ["control: running"];

    if (status.pid !== undefined) {
        lines.push(`pid: ${status.pid}`);
    }

    lines.push(`instances: ${status.instanceCount}`);
    return `${lines.join("\n")}\n`;
}

export function renderControlLogs(logs: string): string {
    return logs.endsWith("\n") || logs.length === 0 ? logs : `${logs}\n`;
}

import type { CliParsedCommand } from "../../Parse.js";
import type { CliDispatchContext } from "../../Dispatch.js";

export interface CliLifecycleManagerLike {
    logs(): Promise<string>;
    start(): Promise<{ instanceCount: number; pid?: number; running: boolean }>;
    status(): Promise<{
        instanceCount: number;
        pid?: number;
        running: boolean;
    }>;
    stop(): Promise<{ instanceCount: number; pid?: number; running: boolean }>;
}

export async function executeControlLifecycle(
    command: CliParsedCommand,
    context: CliDispatchContext,
): Promise<boolean> {
    switch (command.kind) {
        case "control.start": {
            const status = await (await context.lifecycle()).start();
            context.writeValue(status, renderControlStatus(status));
            return true;
        }
        case "control.stop": {
            const status = await (await context.lifecycle()).stop();
            context.writeValue(status, renderControlStatus(status));
            return true;
        }
        case "control.status": {
            const status = await (await context.lifecycle()).status();
            context.writeValue(status, renderControlStatus(status));
            return true;
        }
        case "control.logs": {
            const logs = await (await context.lifecycle()).logs();
            context.writeValue(logs, renderControlLogs(logs));
            return true;
        }
        case "control.restart": {
            const lifecycle = await context.lifecycle();
            const current = await lifecycle.status();
            if (current.running && !context.controlNegotiated)
                await context.negotiate();
            // Control lists configured Instances only; its snapshots are
            // inactive placeholders. Check each Instance's own live Process.
            const restore = current.running
                ? (await Promise.all((await context.clients.instance.listInstances())
                    .filter((entry) => entry.enabled)
                    .map(async (entry) => ({
                        name: entry.name,
                        snapshot: (await context.clients.runtime(entry.name).snapshot()).snapshot,
                    })))).filter(({ snapshot }) =>
                    snapshot.reverse === undefined &&
                    (snapshot.daemonState === "running" ||
                        snapshot.daemonState === "starting" ||
                        snapshot.daemonState === "stale"),
                )
                : [];
            await lifecycle.stop();
            const status = await lifecycle.start();
            if (restore.length > 0) {
                await context.clients.reconnect?.();
                await context.negotiate();
            }
            for (const entry of restore)
                await context.clients.runtime(entry.name).start();
            context.writeValue(status, renderControlStatus(status));
            return true;
        }
        default:
            return false;
    }
}
