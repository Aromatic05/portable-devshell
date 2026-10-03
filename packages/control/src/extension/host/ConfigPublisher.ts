import type { ExtensionManifest } from "@portable-devshell/extension";

import {
    ConfigRegistry,
    createCoreConfigRegistry,
} from "../../config/domain/Registry.js";
import {
    assertExtensionCoreConfigAccess,
    extensionConfigDomainDefinition,
} from "../api/cap/config/Control.js";

export class ExtensionConfigPublisher {
    readonly #published = new Set<string>();
    readonly #registry: ConfigRegistry;

    constructor(registry: ConfigRegistry = createCoreConfigRegistry()) {
        this.#registry = registry;
    }

    assertCanReplace(
        id: string,
        generation: string,
        manifest: ExtensionManifest,
    ): void {
        if (manifest.config === undefined) return;
        if (manifest.config.coreAccess !== undefined) {
            assertExtensionCoreConfigAccess(
                id,
                this.#registry,
                manifest.config.coreAccess,
            );
        }
        const definition = extensionConfigDomainDefinition(
            id,
            generation,
            manifest.config,
        );
        if (definition !== undefined) this.#registry.assertCanReplace(definition);
    }

    replace(
        id: string,
        generation: string,
        manifest: ExtensionManifest,
    ): void {
        if (manifest.config === undefined) {
            this.remove(id);
            return;
        }
        if (manifest.config.coreAccess !== undefined) {
            assertExtensionCoreConfigAccess(
                id,
                this.#registry,
                manifest.config.coreAccess,
            );
        }
        const definition = extensionConfigDomainDefinition(
            id,
            generation,
            manifest.config,
        );
        if (definition === undefined) {
            this.remove(id);
            return;
        }
        this.#registry.replace(definition);
        this.#published.add(id);
    }

    remove(id: string): void {
        const definition = this.#registry.get(id);
        if (
            definition?.owner.kind === "extension" &&
            definition.owner.extensionId === id
        ) {
            this.#registry.remove(id, definition.owner);
        }
        this.#published.delete(id);
    }

    clear(): void {
        for (const id of [...this.#published]) this.remove(id);
    }
}
