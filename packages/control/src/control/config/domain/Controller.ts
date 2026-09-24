import type { JsonValue } from "@portable-devshell/shared";

import type { ControlConfigMutationRunner } from "../editor/Lock.js";
import {
    assertConfigDomainValue,
    type ConfigDomainOwner,
    type ConfigRegistry,
    sameConfigOwner,
} from "../Registry.js";
import { ConfigDomainStore } from "./Store.js";

export interface ConfigDomainControllerOptions {
    id: string;
    mutationRunner: ControlConfigMutationRunner;
    owner: ConfigDomainOwner;
    registry: ConfigRegistry;
    store: ConfigDomainStore;
}

export class ConfigDomainController {
    readonly #id: string;
    readonly #mutationRunner: ControlConfigMutationRunner;
    readonly #owner: ConfigDomainOwner;
    readonly #registry: ConfigRegistry;
    readonly #store: ConfigDomainStore;

    constructor(options: ConfigDomainControllerOptions) {
        this.#id = options.id;
        this.#mutationRunner = options.mutationRunner;
        this.#owner = Object.freeze({ ...options.owner });
        this.#registry = options.registry;
        this.#store = options.store;
    }

    async read(): Promise<Readonly<Record<string, JsonValue>>> {
        return await this.#mutationRunner.runExclusive(async () => {
            const definition = this.#requireOwnedDefinition();
            const stored = await this.#store.read();
            const value = stored ?? definition.defaultValue;
            if (value === undefined) {
                throw new Error(
                    `Config domain ${this.#id} does not define a default value.`,
                );
            }
            assertConfigDomainValue(definition, value);
            return cloneConfigValue(value);
        });
    }

    async write(
        value: Readonly<Record<string, JsonValue>>,
    ): Promise<Readonly<Record<string, JsonValue>>> {
        return await this.#mutationRunner.runExclusive(async () => {
            const definition = this.#requireOwnedDefinition();
            assertConfigDomainValue(definition, value);
            const cloned = cloneConfigValue(value);
            await this.#store.write(cloned);
            return cloneConfigValue(cloned);
        });
    }

    #requireOwnedDefinition() {
        const definition = this.#registry.require(this.#id);
        if (!sameConfigOwner(definition.owner, this.#owner)) {
            throw new Error(
                `Config domain ${this.#id} ownership changed while this generation was active.`,
            );
        }
        return definition;
    }
}

function cloneConfigValue(
    value: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
    return structuredClone(value);
}
