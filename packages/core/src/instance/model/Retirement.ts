import { createRemoteError, runtimeErrorCodes } from "@portable-devshell/shared";

import type { Instance } from "./Instance.js";

export function assertInstanceDeletable(
    instanceName: string,
    descriptor: Instance | undefined,
): boolean {
    if (descriptor === undefined) return false;
    const snapshot = descriptor.worker.supervision.snapshot();
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
        await descriptor.worker.provision
            .retireRuntime()
            .catch((error: unknown) => failures.push(error));
    }
    await descriptor.worker.provision
        .retireProviderResources()
        .catch((error: unknown) => failures.push(error));
    if (failures.length > 0) {
        throw new AggregateError(
            failures,
            `Instance ${descriptor.config.name} delete cleanup was incomplete.`,
        );
    }
}

export async function closeInstanceResources(
    descriptor: Instance,
): Promise<void> {
    const failures: unknown[] = [];
    await descriptor.worker.supervision
        .close()
        .catch((error: unknown) => failures.push(error));
    if (failures.length > 0) {
        throw new AggregateError(
            failures,
            `Failed to close instance ${descriptor.config.name} resources.`,
        );
    }
}
