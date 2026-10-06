import type { ControlConfig } from "@portable-devshell/shared";

export class InstanceRetirementNotification {
    readonly #instanceDisableRetirements = new Set<
        (instance: ControlConfig["instances"][number]) => Promise<void>
    >();
    readonly #instanceDisabled = new Set<
        (instance: ControlConfig["instances"][number]) => Promise<void>
    >();
    readonly #instanceDeleted = new Set<
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

    registerInstanceDisabled(
        listener: (
            instance: ControlConfig["instances"][number],
        ) => Promise<void>,
    ): () => void {
        this.#instanceDisabled.add(listener);
        return () => this.#instanceDisabled.delete(listener);
    }

    registerInstanceDeleted(
        listener: (
            instance: ControlConfig["instances"][number],
        ) => Promise<void>,
    ): () => void {
        this.#instanceDeleted.add(listener);
        return () => this.#instanceDeleted.delete(listener);
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

    async notifyDisabled(
        instance: ControlConfig["instances"][number],
    ): Promise<void> {
        await this.#notify(this.#instanceDisabled, instance);
    }

    async notifyDeleted(
        instance: ControlConfig["instances"][number],
    ): Promise<void> {
        await this.#notify(this.#instanceDeleted, instance);
    }

    async #notify(
        listeners: ReadonlySet<
            (instance: ControlConfig["instances"][number]) => Promise<void>
        >,
        instance: ControlConfig["instances"][number],
    ): Promise<void> {
        const failures: unknown[] = [];
        for (const listener of [...listeners])
            await listener(instance).catch((error) => failures.push(error));
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(
                failures,
                `Instance ${instance.name} lifecycle cleanup failed.`,
            );
        }
    }
}
