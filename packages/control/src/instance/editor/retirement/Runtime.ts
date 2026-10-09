import {
    createRemoteError,
    runtimeErrorCodes,
} from "@portable-devshell/shared";
import type { Instance } from "@portable-devshell/core";

export function assertInstanceDeletable(
    instanceName: string,
    descriptor: Instance | undefined,
): boolean {
    if (descriptor === undefined) return false;
    const snapshot = descriptor.supervision.snapshot();
    if (snapshot.daemonState === "stopped") return false;
    if (
        snapshot.daemonState === "failed" ||
        snapshot.daemonState === "stale"
    ) {
        return true;
    }
    throw createRemoteError({
        code: runtimeErrorCodes.instanceConflict,
        details: {
            instance: instanceName,
            operation: "delete",
            status: snapshot.status,
        },
        message: `Instance ${instanceName} must be stopped before delete.`,
        retryable: false,
    });
}
