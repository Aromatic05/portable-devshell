import type { CliInstanceSnapshotEnvelope } from "../../control/CliControlStream.js";

export function renderInstanceSnapshot(snapshot: CliInstanceSnapshotEnvelope["snapshot"]): string {
    return [
        `instance: ${snapshot.name}`,
        `status: ${snapshot.status}`,
        `ready: ${snapshot.ready}`,
        `daemonState: ${snapshot.daemonState}`,
        `connectionState: ${snapshot.connectionState}`,
        `lastSeq: ${snapshot.lastSeq}`
    ].join("\n") + "\n";
}
