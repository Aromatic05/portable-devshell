import type { InstanceLogEntry } from "@portable-devshell/shared";

export function renderInstanceLogs(entries: readonly InstanceLogEntry[]): string {
    if (entries.length === 0) {
        return "";
    }

    return `${entries.map((entry) => `[${entry.seq}] ${entry.stream} ${entry.message.replace(/\n$/u, "")}`).join("\n")}\n`;
}
