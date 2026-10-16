import type { Instance } from "@portable-devshell/core";

export function assertInstanceDeletable(
    _instanceName: string,
    descriptor: Instance | undefined,
): boolean {
    if (descriptor === undefined) return false;
    const snapshot = descriptor.supervision.snapshot();
    // A worker's liveness is not a precondition for deleting its Control
    // registration. Only skip remote retirement when its daemon is unknown or
    // already failed; active managed workers are retired by the cleanup phase.
    return ["failed", "stale", "unknown"].includes(snapshot.daemonState);
}
