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

export async function retireInstanceForDelete(
    descriptor: Instance | undefined,
    skipRuntimeRetirement = false,
): Promise<void> {
    if (descriptor === undefined) return;
    const failures: unknown[] = [];
    if (!skipRuntimeRetirement) {
        await descriptor.provision
            .retireRuntime()
            .catch((error: unknown) => failures.push(error));
    }
    await descriptor.provision
        .retireProviderResources()
        .catch((error: unknown) => failures.push(error));
    if (failures.length > 0) {
        throw new AggregateError(
            failures,
            `Instance ${descriptor.config.name} delete cleanup was incomplete.`,
        );
    }
}
