import type {
    ExtensionManifest,
    ExtensionPointDeclaration
} from "@portable-devshell/extension";

import { readExtensionDeclarations } from "./ExtensionRegistration.js";

export interface ExtensionCatalogRegistration {
    readonly declaration: ExtensionPointDeclaration;
    readonly extensionId: string;
    readonly generation: string;
    readonly id: string;
    readonly pointId: string;
}

export interface ExtensionCatalogGeneration {
    readonly generation: string;
    readonly manifest: ExtensionManifest;
}

/** Static manifest-backed catalog. Runtime bindings remain generation-owned elsewhere. */
export class ExtensionCatalog {
    readonly #extensions = new Map<string, ExtensionCatalogGeneration>();
    readonly #registrations = new Map<string, ExtensionCatalogRegistration>();

    get(pointId: string, id: string): ExtensionCatalogRegistration | undefined {
        return this.#registrations.get(registrationKey(pointId, id));
    }

    getExtension(extensionId: string): ExtensionCatalogGeneration | undefined {
        return this.#extensions.get(extensionId);
    }

    list(pointId: string): readonly ExtensionCatalogRegistration[] {
        return [...this.#registrations.values()]
            .filter((registration) => registration.pointId === pointId)
            .sort((left, right) =>
                left.id.localeCompare(right.id) || left.extensionId.localeCompare(right.extensionId)
            );
    }

    remove(extensionId: string): void {
        this.#extensions.delete(extensionId);
        for (const [key, registration] of this.#registrations) {
            if (registration.extensionId === extensionId) this.#registrations.delete(key);
        }
    }

    assertCanReplace(extensionId: string, generation: string, manifest: ExtensionManifest): void {
        this.#prepare(extensionId, generation, manifest);
    }

    replace(extensionId: string, generation: string, manifest: ExtensionManifest): void {
        const registrations = this.#prepare(extensionId, generation, manifest);
        this.remove(extensionId);
        this.#extensions.set(extensionId, Object.freeze({ generation, manifest }));
        for (const registration of registrations) {
            this.#registrations.set(registrationKey(registration.pointId, registration.id), registration);
        }
    }

    #prepare(
        extensionId: string,
        generation: string,
        manifest: ExtensionManifest
    ): readonly ExtensionCatalogRegistration[] {
        if (manifest.id !== extensionId) {
            throw new TypeError(
                `Extension generation ${generation} declares id ${manifest.id}, expected ${extensionId}.`
            );
        }
        const registrations = readExtensionDeclarations(manifest).map((entry) => Object.freeze({
            declaration: entry.declaration,
            extensionId,
            generation,
            id: entry.id,
            pointId: entry.pointId
        }));
        for (const registration of registrations) {
            const existing = this.#registrations.get(registrationKey(registration.pointId, registration.id));
            if (existing === undefined || existing.extensionId === extensionId) continue;
            throw new TypeError(
                `Extension registration conflict for ${registration.pointId}/${registration.id}: `
                + `${extensionId} and ${existing.extensionId}.`
            );
        }
        return registrations;
    }
}

function registrationKey(pointId: string, id: string): string {
    return `${pointId}\u0000${id}`;
}
