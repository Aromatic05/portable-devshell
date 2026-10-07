import { createInstance, type Instance } from "@portable-devshell/core";
import type { ControlConfig } from "@portable-devshell/shared";

import { InstanceChangeHub } from "./Change.js";
import { InstanceRegistry } from "./Registry.js";

export class ControlInstances {
    readonly changes = new InstanceChangeHub();
    #registry = new InstanceRegistry([]);

    get registry(): InstanceRegistry {
        return this.#registry;
    }

    async load(config: ControlConfig): Promise<void> {
        const created: Instance[] = [];
        try {
            for (const definition of config.instances) {
                if (!definition.enabled) continue;
                created.push(createInstance(definition));
            }
            this.#registry = new InstanceRegistry(created);
        } catch (error) {
            const cleanupFailures: unknown[] = [];
            for (const instance of created)
                await instance.close().catch((cleanupError) =>
                    cleanupFailures.push(cleanupError),
                );
            this.reset();
            if (cleanupFailures.length > 0) {
                throw new AggregateError(
                    [error, ...cleanupFailures],
                    "Control instance load failed and cleanup was incomplete.",
                );
            }
            throw error;
        }
    }

    async close(): Promise<void> {
        const failures: unknown[] = [];
        for (const instance of this.#registry.list()) {
            const supervision = instance.supervision;
            if (supervision.ownership.owned) {
                try {
                    await supervision.lifecycle.stop();
                    supervision.ownership.clearOwned();
                } catch (error) {
                    failures.push(error);
                }
            }
            await instance.close().catch((error) => failures.push(error));
        }
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                `Failed to close ${failures.length} instance resource(s).`,
            );
        }
    }

    reset(): void {
        this.#registry = new InstanceRegistry([]);
    }
}
