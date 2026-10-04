import type { InstanceFactory, InstanceRegistry } from "@portable-devshell/core";

export class InstanceRetirementState {
    async retireForDelete(
        descriptor: ReturnType<InstanceRegistry["get"]>,
        skipRuntimeRetirement = false,
    ): Promise<void> {
        if (descriptor === undefined) return;
        const reason = `Instance ${descriptor.name} was deleted.`;
        const failures: unknown[] = [];

        await descriptor.approval
            .retire(reason)
            .catch((error) => failures.push(error));

        if (descriptor.task.wait !== undefined) {
            try {
                for (const wait of await descriptor.task.wait.list()) {
                    if (
                        wait.status !== "waiting" &&
                        wait.status !== "detached" &&
                        wait.status !== "resolved"
                    )
                        continue;
                    try {
                        if (wait.status === "resolved")
                            await descriptor.task.wait.consume(wait.waitId);
                        else await descriptor.task.wait.cancel(wait.waitId);
                    } catch (error) {
                        let current;
                        try {
                            current = await descriptor.task.wait.get(wait.waitId);
                        } catch (readError) {
                            failures.push(error, readError);
                            continue;
                        }
                        if (
                            current === undefined ||
                            current.status === "cancelled" ||
                            current.status === "consumed"
                        )
                            continue;
                        if (
                            current.status === "resolved" &&
                            wait.status !== "resolved"
                        ) {
                            try {
                                await descriptor.task.wait.consume(wait.waitId);
                                continue;
                            } catch (consumeError) {
                                failures.push(error, consumeError);
                                continue;
                            }
                        }
                        failures.push(error);
                    }
                }
            } catch (error) {
                failures.push(error);
            }
        }

        await descriptor.task.goal.stopAll().catch((error) => failures.push(error));
        await descriptor.task.todo
            .cancelAll()
            .catch((error) => failures.push(error));
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

    async retireDisabledInteractions(
        descriptor: ReturnType<InstanceFactory["map"]>,
    ): Promise<unknown[]> {
        const failures: unknown[] = [];
        await descriptor.approval
            .retire(
                `Instance ${descriptor.name} was disabled before approval.`,
            )
            .catch((error) => failures.push(error));
        if (descriptor.task.wait !== undefined) {
            try {
                for (const wait of await descriptor.task.wait.list()) {
                    if (
                        wait.status !== "waiting" &&
                        wait.status !== "detached"
                    )
                        continue;
                    await descriptor.task.wait
                        .cancel(wait.waitId)
                        .catch((error) => failures.push(error));
                }
            } catch (error) {
                failures.push(error);
            }
        }
        return failures;
    }
}

export async function closeDescriptorResourcesBestEffort(
    descriptor: ReturnType<InstanceFactory["map"]>,
): Promise<void> {
    const failures: unknown[] = [];
    await descriptor.approval.retire().catch((error) => failures.push(error));
    try {
        descriptor.approval.close();
    } catch (error) {
        failures.push(error);
    }
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
