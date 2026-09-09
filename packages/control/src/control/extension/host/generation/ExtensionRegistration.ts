import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type {
    ExtensionManifest,
    ExtensionPoint,
    ExtensionPointDeclaration
} from "@portable-devshell/extension";
import {
    commands,
    parseCliCommandDeclaration
} from "@portable-devshell/extension/cli";
import {
    applications,
    parseWebApplicationDeclaration,
    type WebApplicationBinding
} from "@portable-devshell/extension/web";

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

    constructor(manifest: ExtensionManifest, codeDirectory: string) {
        this.#manifest = manifest;
        this.#codeDirectory = codeDirectory;
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
        validateBinding(pointId, binding, this.#manifest.id, id);
        const key = registrationKey(pointId, id);
        if (this.#bindings.has(key)) {
            throw new TypeError(`Extension ${this.#manifest.id} registered ${pointId}/${id} more than once.`);
        }
        this.#bindings.set(key, { binding, id, pointId });
    }

    async finalize(): Promise<ExtensionRegistrationSet> {
        const registrations: ExtensionRuntimeRegistration[] = [];
        for (const entry of readExtensionDeclarations(this.#manifest)) {
            const binding = this.#bindings.get(registrationKey(entry.pointId, entry.id));
            if (binding === undefined) {
                throw new TypeError(
                    `Extension ${this.#manifest.id} declares ${entry.pointId}/${entry.id} but did not bind it.`
                );
            }
            await validateBindingResources(
                entry.pointId,
                binding.binding,
                this.#codeDirectory,
                this.#manifest.id,
                entry.id
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
}

/** Validate manifest declarations without importing or activating Extension code. */
export function readExtensionDeclarations(manifest: ExtensionManifest): readonly ExtensionRuntimeDeclaration[] {
    const declarations: ExtensionRuntimeDeclaration[] = [];
    for (const [pointId, entries] of Object.entries(manifest.extensions)) {
        for (const declaration of entries) {
            declarations.push(Object.freeze({
                declaration: validateDeclaration(pointId, declaration, manifest.id),
                id: declaration.id,
                pointId
            }));
        }
    }
    return declarations;
}

function validateDeclaration(
    pointId: string,
    declaration: ExtensionPointDeclaration,
    extensionId: string
): ExtensionPointDeclaration {
    switch (pointId) {
        case commands.id:
            return parseCliCommandDeclaration(declaration);
        case applications.id:
            return parseWebApplicationDeclaration(declaration);
        default:
            throw new TypeError(`Extension ${extensionId} declares unsupported Extension Point ${pointId}.`);
    }
}

function validateBinding(pointId: string, binding: unknown, extensionId: string, id: string): void {
    switch (pointId) {
        case commands.id:
            if (typeof binding !== "function") {
                throw new TypeError(`Extension ${extensionId} cli.commands/${id} binding must be a function.`);
            }
            return;
        case applications.id:
            validateWebBinding(binding, extensionId, id);
            return;
        default:
            throw new TypeError(`Extension ${extensionId} cannot bind unsupported Extension Point ${pointId}.`);
    }
}

async function validateBindingResources(
    pointId: string,
    binding: unknown,
    codeDirectory: string,
    extensionId: string,
    id: string
): Promise<void> {
    if (pointId !== applications.id) return;
    const source = (binding as WebApplicationBinding).source;
    if (source.kind !== "files") return;
    const directory = resolveContainedPath(codeDirectory, source.directory, "Web application directory");
    const info = await lstat(directory).catch(() => undefined);
    if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) {
        throw new TypeError(`Extension ${extensionId} web.applications/${id} files source is not a plain directory.`);
    }
}

function validateWebBinding(value: unknown, extensionId: string, id: string): asserts value is WebApplicationBinding {
    if (!isRecord(value) || !isRecord(value.source)) {
        throw new TypeError(`Extension ${extensionId} web.applications/${id} binding must provide source.`);
    }
    const source = value.source;
    if (source.kind === "files") {
        if (Object.keys(source).some((key) => key !== "directory" && key !== "kind")) {
            throw new TypeError(`Extension ${extensionId} web.applications/${id} files source has unknown fields.`);
        }
        if (typeof source.directory !== "string" || source.directory.length === 0) {
            throw new TypeError(`Extension ${extensionId} web.applications/${id} files directory must be non-empty.`);
        }
        return;
    }
    if (source.kind === "endpoint") {
        if (Object.keys(source).some((key) => key !== "kind" && key !== "resolve")) {
            throw new TypeError(`Extension ${extensionId} web.applications/${id} endpoint source has unknown fields.`);
        }
        if (typeof source.resolve !== "function") {
            throw new TypeError(`Extension ${extensionId} web.applications/${id} endpoint source must provide resolve().`);
        }
        return;
    }
    throw new TypeError(`Extension ${extensionId} web.applications/${id} source kind is invalid.`);
}

function readPointId(value: unknown): string {
    if (isRecord(value) && typeof value.id === "string") return value.id;
    throw new TypeError("Extension registration requires an Extension Point descriptor.");
}

function registrationKey(pointId: string, id: string): string {
    return `${pointId}\u0000${id}`;
}

function resolveContainedPath(root: string, child: string, label: string): string {
    if (isAbsolute(child)) throw new TypeError(`${label} must be relative to the Extension code directory.`);
    const resolved = resolve(root, child);
    const rel = relative(root, resolved);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return resolved;
    throw new TypeError(`${label} escapes the Extension code directory.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
