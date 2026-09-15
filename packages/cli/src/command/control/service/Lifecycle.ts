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
        case "control.start":
            context.stdout.write(
                renderControlStatus(await (await context.lifecycle()).start()),
            );
            return true;
        case "control.stop":
            context.stdout.write(
                renderControlStatus(await (await context.lifecycle()).stop()),
            );
            return true;
        case "control.status":
            context.stdout.write(
                renderControlStatus(await (await context.lifecycle()).status()),
            );
            return true;
        case "control.logs":
            context.stdout.write(
                renderControlLogs(await (await context.lifecycle()).logs()),
            );
            return true;
        case "control.restart": {
            const lifecycle = await context.lifecycle();
            const current = await lifecycle.status();
            if (current.running && !context.controlNegotiated)
                await context.negotiate();
            const restore = current.running
                ? (await context.clients.instance.list()).filter(
                      (entry) =>
                          entry.snapshot.reverse === undefined &&
                          (entry.snapshot.daemonState === "running" ||
                              entry.snapshot.daemonState === "starting" ||
                              entry.snapshot.daemonState === "stale"),
                  )
                : [];
            await lifecycle.stop();
            const status = await lifecycle.start();
            if (restore.length > 0) {
                await context.clients.reconnect?.();
                await context.negotiate();
            }
            for (const entry of restore)
                await context.clients.runtime.start(entry.name);
            context.stdout.write(renderControlStatus(status));
            return true;
        }
        default:
            return false;
    }
}
