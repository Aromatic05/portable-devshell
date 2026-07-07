import type { CliInstanceListEntry } from "../../control/CliControlStream.js";

export function renderInstanceList(instances: readonly CliInstanceListEntry[]): string {
    if (instances.length === 0) {
        return "no instances\n";
    }

    return `${instances.map((instance) => `${instance.name}\t${instance.snapshot.status}\tready=${instance.snapshot.ready}`).join("\n")}\n`;
}
