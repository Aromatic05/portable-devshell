import type { Instance } from "@portable-devshell/core";

export function assertInstanceDeletable(
    _instanceName: string,
    descriptor: Instance | undefined,
): boolean {
    if (descriptor === undefined) return false;
    if (descriptor.supervision.managementMode === "selfManaged") return true;
    if (descriptor.config.provider === "local") return false;
    const snapshot = descriptor.supervision.snapshot();
    // Local cleanup must resolve stale residue through native stop/retire.
    // Unavailable remote runtimes cannot be safely targeted by name alone.
    return ["failed", "stale", "unknown"].includes(snapshot.daemonState);
}
