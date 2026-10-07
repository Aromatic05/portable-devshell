import type { ControlConfig } from "@portable-devshell/shared";

export class InstanceRetirementHooks {
    readonly #instanceDisableRetirements = new Set<
        (instance: ControlConfig["instances"][number]) => Promise<void>
    >();
    readonly #instanceDeleteRetirements = new Set<
        (instance: ControlConfig["instances"][number]) => Promise<void>
    >();
    readonly #instanceGenerationRetirements = new Set<
        (instance: ControlConfig["instances"][number]) => Promise<void>
    >();

    registerInstanceDeleteRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        this.#instanceDeleteRetirements.add(retire);
        return () => this.#instanceDeleteRetirements.delete(retire);
    }

    registerInstanceDisableRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        this.#instanceDisableRetirements.add(retire);
        return () => this.#instanceDisableRetirements.delete(retire);
    }

    registerInstanceGenerationRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        this.#instanceGenerationRetirements.add(retire);
        return () => this.#instanceGenerationRetirements.delete(retire);
    }

    async retireGenerationResources(
        instance: ControlConfig["instances"][number],
    ): Promise<void> {
        const failures: unknown[] = [];
        for (const retire of [...this.#instanceGenerationRetirements])
            await retire(instance).catch((error) => failures.push(error));
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                `Instance ${instance.name} generation retirement was incomplete.`,
            );
        }
    }

    async retireDisable(
        instance: ControlConfig["instances"][number],
    ): Promise<unknown[]> {
        const failures: unknown[] = [];
        for (const retire of [...this.#instanceDisableRetirements])
            await retire(instance).catch((error) => failures.push(error));
        return failures;
    }

    async retireDelete(
        instance: ControlConfig["instances"][number],
    ): Promise<unknown[]> {
        const failures: unknown[] = [];
        for (const retire of [...this.#instanceDeleteRetirements])
            await retire(instance).catch((error) => failures.push(error));
        return failures;
    }

}
