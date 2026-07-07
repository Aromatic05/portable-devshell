import type { CliInstanceLogEntry } from "../../control/CliControlStream.js";

export function renderInstanceLogs(entries: readonly CliInstanceLogEntry[]): string {
    if (entries.length === 0) {
        return "";
    }

    return `${entries.map((entry) => `[${entry.seq}] ${entry.stream} ${entry.message.replace(/\n$/u, "")}`).join("\n")}\n`;
}
