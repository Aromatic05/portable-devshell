import type {
    ExtensionManifest,
    ExtensionPoint,
    ExtensionPointDeclaration
} from "@portable-devshell/extension";

import { ExtensionPointRegistry } from "./ExtensionPointRegistry.js";

export interface ExtensionRuntimeRegistration {
    readonly binding: unknown;
    readonly declaration: ExtensionPointDeclaration;
    readonly id: string;
    readonly pointId: string;
}

export interface ExtensionRuntimeDeclaration {
    readonly declaration: ExtensionPointDeclaration;
    readonly id: string;
    readonly pointId: string;
}

export class ExtensionRegistrationSet {
    readonly #entries: ReadonlyMap<string, ExtensionRuntimeRegistration>;

    constructor(entries: readonly ExtensionRuntimeRegistration[]) {
        this.#entries = new Map(entries.map((entry) => [registrationKey(entry.pointId, entry.id), entry]));
    }

    get(pointId: string, id: string): ExtensionRuntimeRegistration | undefined {
        return this.#entries.get(registrationKey(pointId, id));
    }

    list(pointId?: string): readonly ExtensionRuntimeRegistration[] {
        const entries = [...this.#entries.values()];
        return pointId === undefined ? entries : entries.filter((entry) => entry.pointId === pointId);
    }
}

/** Captures one generation's bindings and validates them against static manifest declarations. */
export class ExtensionRegistrationBuilder {
    readonly #bindings = new Map<string, { binding: unknown; id: string; pointId: string }>();
    readonly #codeDirectory: string;
    readonly #manifest: ExtensionManifest;
    readonly #points: ExtensionPointRegistry;

    constructor(manifest: ExtensionManifest, codeDirectory: string, points: ExtensionPointRegistry) {
        this.#manifest = manifest;
        this.#codeDirectory = codeDirectory;
        this.#points = points;
    }

    register<Declaration extends ExtensionPointDeclaration, Binding>(
        point: ExtensionPoint<Declaration, Binding>,
        id: string,
        binding: Binding
    ): void {
        this.registerById(readPointId(point), id, binding);
    }

    registerById(pointId: string, id: string, binding: unknown): void {
        if (!/^[a-z][a-z0-9-]*$/u.test(id)) {
            throw new TypeError(`Extension registration id must match [a-z][a-z0-9-]*: ${id}.`);
        }
        const declaration = this.#manifest.extensions[pointId]?.find((candidate) => candidate.id === id);
        if (declaration === undefined) {
            throw new TypeError(
                `Extension ${this.#manifest.id} registered undeclared ${pointId}/${id}.`
            );
        }
        this.#points.validateBinding(pointId, binding, this.#validationContext(id));
        const key = registrationKey(pointId, id);
        if (this.#bindings.has(key)) {
            throw new TypeError(`Extension ${this.#manifest.id} registered ${pointId}/${id} more than once.`);
        }
        this.#bindings.set(key, { binding, id, pointId });
    }

    async finalize(): Promise<ExtensionRegistrationSet> {
        const registrations: ExtensionRuntimeRegistration[] = [];
        for (const entry of readExtensionDeclarations(this.#manifest, this.#points)) {
            const binding = this.#bindings.get(registrationKey(entry.pointId, entry.id));
            if (binding === undefined) {
                throw new TypeError(
                    `Extension ${this.#manifest.id} declares ${entry.pointId}/${entry.id} but did not bind it.`
                );
            }
            await this.#points.validateBindingResources(
                entry.pointId,
                binding.binding,
                this.#validationContext(entry.id)
            );
            registrations.push(Object.freeze({
                binding: binding.binding,
                declaration: entry.declaration,
                id: entry.id,
                pointId: entry.pointId
            }));
        }
        if (registrations.length !== this.#bindings.size) {
            throw new Error(`Extension ${this.#manifest.id} registration set is inconsistent with its manifest.`);
        }
        return new ExtensionRegistrationSet(registrations);
    }

    #validationContext(id: string) {
        return Object.freeze({
            codeDirectory: this.#codeDirectory,
            extensionId: this.#manifest.id,
            id
        });
    }
}

/** Validate manifest declarations without importing or activating Extension code. */
export function readExtensionDeclarations(
    manifest: ExtensionManifest,
    points: ExtensionPointRegistry
): readonly ExtensionRuntimeDeclaration[] {
    const declarations: ExtensionRuntimeDeclaration[] = [];
    for (const [pointId, entries] of Object.entries(manifest.extensions)) {
        for (const declaration of entries) {
            declarations.push(Object.freeze({
                declaration: points.parseDeclaration(pointId, declaration, manifest.id),
                id: declaration.id,
                pointId
            }));
        }
    }
    return declarations;
}

function readPointId(value: unknown): string {
    if (isRecord(value) && typeof value.id === "string") return value.id;
    throw new TypeError("Extension registration requires an Extension Point descriptor.");
}

function registrationKey(pointId: string, id: string): string {
    return `${pointId}\u0000${id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
