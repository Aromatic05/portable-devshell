import type { InstanceFactory, InstanceRegistry } from "@portable-devshell/core";

export class InstanceRetirementState {
    async retireForDelete(
        descriptor: ReturnType<InstanceRegistry["get"]>,
        skipRuntimeRetirement = false,
    ): Promise<void> {
        if (descriptor === undefined) return;
        const failures: unknown[] = [];
        if (!skipRuntimeRetirement) {
            await descriptor.worker
                .retireRuntime()
                .catch((error) => failures.push(error));
        }
        await descriptor.worker
            .retireProviderResources()
            .catch((error) => failures.push(error));
        if (failures.length > 0)
            throw new AggregateError(
                failures,
                `Instance ${descriptor.name} delete cleanup was incomplete.`,
            );
    }

}

export async function closeDescriptorResourcesBestEffort(
    descriptor: ReturnType<InstanceFactory["map"]>,
): Promise<void> {
    const failures: unknown[] = [];
    const close = (descriptor.worker as { close?: () => Promise<void> }).close;
    if (close !== undefined) {
        await close
            .call(descriptor.worker)
            .catch((error) => failures.push(error));
    }
    if (failures.length > 0) {
        throw new AggregateError(
            failures,
            `Failed to close instance ${descriptor.name} resources.`,
        );
    }
}
