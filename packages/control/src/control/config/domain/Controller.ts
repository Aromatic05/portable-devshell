import type { JsonValue } from "@portable-devshell/shared";

import type { ControlConfigMutationRunner } from "../editor/Lock.js";
import {
    assertConfigDomainValue,
    type ConfigDomainDefinition,
    type ConfigRegistry,
    normalizeConfigDomainDefinition,
    sameConfigOwner,
} from "../Registry.js";
import { ConfigDomainStore } from "./Store.js";

export interface ConfigDomainControllerOptions {
    definition: ConfigDomainDefinition;
    mutationRunner: ControlConfigMutationRunner;
    registry: ConfigRegistry;
    store: ConfigDomainStore;
}

export class ConfigDomainController {
    readonly #definition: ConfigDomainDefinition;
    readonly #mutationRunner: ControlConfigMutationRunner;
    readonly #registry: ConfigRegistry;
    readonly #store: ConfigDomainStore;

    constructor(options: ConfigDomainControllerOptions) {
        this.#definition = normalizeConfigDomainDefinition(options.definition);
        this.#mutationRunner = options.mutationRunner;
        this.#registry = options.registry;
        this.#store = options.store;
    }

    async read(): Promise<Readonly<Record<string, JsonValue>>> {
        return await this.#mutationRunner.runExclusive(async () => {
            const stored = await this.#store.read();
            const value = stored ?? this.#definition.defaultValue;
            if (value === undefined) {
                throw new Error(
                    `Config domain ${this.#definition.id} does not define a default value.`,
                );
            }
            assertConfigDomainValue(this.#definition, value);
            return cloneConfigValue(value);
        });
    }

    async write(
        value: Readonly<Record<string, JsonValue>>,
    ): Promise<Readonly<Record<string, JsonValue>>> {
        return (await this.update(() => value)).next;
    }

    async update(
        transform: (
            current: Readonly<Record<string, JsonValue>>,
        ) => Readonly<Record<string, JsonValue>>,
    ): Promise<{
        next: Readonly<Record<string, JsonValue>>;
        previous: Readonly<Record<string, JsonValue>>;
    }> {
        return await this.#mutationRunner.runExclusive(async () => {
            this.#assertCurrentOwner();
            const stored = await this.#store.read();
            const current = stored ?? this.#definition.defaultValue;
            if (current === undefined) {
                throw new Error(
                    `Config domain ${this.#definition.id} does not define a default value.`,
                );
            }
            assertConfigDomainValue(this.#definition, current);
            const previous = cloneConfigValue(current);
            const next = cloneConfigValue(transform(previous));
            assertConfigDomainValue(this.#definition, next);
            await this.#store.write(next);
            return {
                next: cloneConfigValue(next),
                previous,
            };
        });
    }

    #assertCurrentOwner(): void {
        const current = this.#registry.get(this.#definition.id);
        if (
            current === undefined ||
            !sameConfigOwner(current.owner, this.#definition.owner)
        ) {
            throw new Error(
                `Config domain ${this.#definition.id} is not writable by this generation.`,
            );
        }
    }
}

function cloneConfigValue(
    value: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
    return structuredClone(value);
}
