import { join } from "node:path";

import type {
    ExtensionConfig,
    ExtensionConfigChange,
    ExtensionConfigDeclaration,
    ExtensionCoreConfigAccess,
    ExtensionJsonValue,
} from "@portable-devshell/extension";
import type { ExtensionCoreConfigCapability } from "@portable-devshell/extension/config";
import type { ControlConfig, JsonValue } from "@portable-devshell/shared";

import {
    ConfigChangeHub,
    type ConfigCommittedChange,
} from "../../config/Change.js";
import { ConfigDomainController } from "../../config/domain/Controller.js";
import { ConfigDomainStore } from "../../config/domain/Store.js";
import type { ControlConfigMutationRunner } from "../../config/editor/Lock.js";
import {
    diffConfigPaths,
    getConfigPathValue,
    parseConfigPath,
    setConfigPathValue,
} from "../../config/Path.js";
import type {
    ConfigDomainDefinition,
    ConfigPathPermission,
    ConfigRegistry,
} from "../../config/Registry.js";

export interface ExtensionConfigControlOptions {
    changeHub: ConfigChangeHub;
    declaration: ExtensionConfigDeclaration;
    extensionId: string;
    generation: string;
    mutationRunner: ControlConfigMutationRunner;
    readCoreConfig: () => ControlConfig;
    registry: ConfigRegistry;
    stateDirectory: string;
    updateCoreConfig: (
        patch: Readonly<Record<string, JsonValue>>,
    ) => Promise<void>;
}

interface ExtensionOwnedConfigRuntime extends ExtensionConfig {
    close(): void;
    validate(): Promise<void>;
}

export interface ExtensionCoreConfigRuntime extends ExtensionCoreConfigCapability {
    close(): void;
    validate(): Promise<void>;
}

export interface ExtensionConfigRuntime {
    readonly core?: ExtensionCoreConfigRuntime;
    readonly owned?: ExtensionOwnedConfigRuntime;
    close(): void;
    validate(): Promise<void>;
}

export class ExtensionConfigControl implements ExtensionConfigRuntime {
    readonly core?: ExtensionCoreConfigRuntime;
    readonly owned?: ExtensionOwnedConfigRuntime;

    constructor(options: ExtensionConfigControlOptions) {
        const definition = extensionConfigDomainDefinition(
            options.extensionId,
            options.generation,
            options.declaration,
        );
        if (definition !== undefined) {
            this.owned = new ExtensionOwnedConfigControl({
                changeHub: options.changeHub,
                definition,
                extensionId: options.extensionId,
                mutationRunner: options.mutationRunner,
                registry: options.registry,
                stateDirectory: options.stateDirectory,
            });
        }
        if (options.declaration.coreAccess !== undefined) {
            this.core = new ExtensionCoreConfigCapabilityControl({
                access: options.declaration.coreAccess,
                changeHub: options.changeHub,
                extensionId: options.extensionId,
                readCoreConfig: options.readCoreConfig,
                registry: options.registry,
                updateCoreConfig: options.updateCoreConfig,
            });
        }
    }

    close(): void {
        this.owned?.close();
        this.core?.close();
    }

    async validate(): Promise<void> {
        await this.owned?.validate();
        await this.core?.validate();
    }
}

interface ExtensionOwnedConfigControlOptions {
    changeHub: ConfigChangeHub;
    definition: ConfigDomainDefinition;
    extensionId: string;
    mutationRunner: ControlConfigMutationRunner;
    registry: ConfigRegistry;
    stateDirectory: string;
}

class ExtensionOwnedConfigControl implements ExtensionOwnedConfigRuntime {
    readonly #changeHub: ConfigChangeHub;
    readonly #controller: ConfigDomainController;
    readonly #extensionId: string;
    readonly #listeners = new Set<(change: ExtensionConfigChange) => void>();
    readonly #unsubscribeChanges: () => void;

    constructor(options: ExtensionOwnedConfigControlOptions) {
        this.#changeHub = options.changeHub;
        this.#extensionId = options.extensionId;
        this.#controller = new ConfigDomainController({
            definition: options.definition,
            mutationRunner: options.mutationRunner,
            registry: options.registry,
            store: new ConfigDomainStore(
                join(options.stateDirectory, "config.json"),
            ),
        });
        this.#unsubscribeChanges = options.changeHub.onChange((change) =>
            this.#acceptChange(change),
        );
    }

    close(): void {
        this.#unsubscribeChanges();
        this.#listeners.clear();
    }

    async get(path: string): Promise<ExtensionJsonValue | undefined> {
        const parsed = this.#requireOwned(path);
        const current = await this.#controller.read();
        return getConfigPathValue(current, parsed.segments) as
            ExtensionJsonValue | undefined;
    }

    onChange(listener: (change: ExtensionConfigChange) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async update(
        patch: Readonly<Record<string, ExtensionJsonValue>>,
    ): Promise<void> {
        const entries = Object.entries(patch);
        if (entries.length === 0) return;
        for (const [path] of entries) this.#requireOwned(path);
        const result = await this.#controller.update((current) => {
            const next = structuredClone(current) as Record<string, JsonValue>;
            for (const [path, value] of entries) {
                const parsed = parseConfigPath(path);
                setConfigPathValue(next, parsed.segments, value as JsonValue);
            }
            return next;
        });
        this.#changeHub.publish(
            diffConfigPaths(result.previous, result.next, this.#extensionId),
        );
    }

    async validate(): Promise<void> {
        await this.#controller.read();
    }

    #acceptChange(change: ConfigCommittedChange): void {
        const paths = change.paths.filter(
            (path) => parseConfigPath(path).domain === this.#extensionId,
        );
        publishChange(paths, this.#listeners);
    }

    #requireOwned(path: string): ReturnType<typeof parseConfigPath> {
        const parsed = parseConfigPath(path);
        if (parsed.domain !== this.#extensionId) {
            throw new Error(
                `Extension ${this.#extensionId} Config does not own path ${path}.`,
            );
        }
        return parsed;
    }
}

interface ExtensionCoreConfigCapabilityControlOptions {
    access: Readonly<Record<string, ExtensionCoreConfigAccess>>;
    changeHub: ConfigChangeHub;
    extensionId: string;
    readCoreConfig: () => ControlConfig;
    registry: ConfigRegistry;
    updateCoreConfig: (
        patch: Readonly<Record<string, JsonValue>>,
    ) => Promise<void>;
}

export class ExtensionCoreConfigCapabilityControl implements ExtensionCoreConfigRuntime {
    readonly #access: Readonly<Record<string, ExtensionCoreConfigAccess>>;
    readonly #extensionId: string;
    readonly #listeners = new Set<(change: ExtensionConfigChange) => void>();
    readonly #readCoreConfig: () => ControlConfig;
    readonly #registry: ConfigRegistry;
    readonly #unsubscribeChanges: () => void;
    readonly #updateCoreConfig: ExtensionCoreConfigCapabilityControlOptions["updateCoreConfig"];

    constructor(options: ExtensionCoreConfigCapabilityControlOptions) {
        this.#access = Object.freeze({ ...options.access });
        this.#extensionId = options.extensionId;
        this.#readCoreConfig = options.readCoreConfig;
        this.#registry = options.registry;
        this.#updateCoreConfig = options.updateCoreConfig;
        this.#unsubscribeChanges = options.changeHub.onChange((change) =>
            this.#acceptChange(change),
        );
    }

    close(): void {
        this.#unsubscribeChanges();
        this.#listeners.clear();
    }

    async get(path: string): Promise<ExtensionJsonValue | undefined> {
        this.#requireAccess(path, "read");
        const parsed = parseConfigPath(path);
        const definition = this.#registry.require(parsed.domain);
        if (definition.owner.kind !== "core") {
            throw new Error(
                `Core Config capability cannot read non-Core path ${path}.`,
            );
        }
        const config = this.#readCoreConfig() as unknown as Record<
            string,
            JsonValue
        >;
        return getConfigPathValue(config[parsed.domain], parsed.segments) as
            ExtensionJsonValue | undefined;
    }

    onChange(listener: (change: ExtensionConfigChange) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async update(
        patch: Readonly<Record<string, ExtensionJsonValue>>,
    ): Promise<void> {
        const entries = Object.entries(patch);
        if (entries.length === 0) return;
        for (const [path] of entries) this.#requireAccess(path, "read-write");
        await this.#updateCoreConfig(
            Object.fromEntries(entries) as Readonly<Record<string, JsonValue>>,
        );
    }

    async validate(): Promise<void> {
        assertExtensionCoreConfigAccess(
            this.#extensionId,
            this.#registry,
            this.#access,
        );
    }

    #acceptChange(change: ConfigCommittedChange): void {
        const paths = change.paths.filter((path) => this.#canRead(path));
        publishChange(paths, this.#listeners);
    }

    #canRead(path: string): boolean {
        const requested = this.#access[path];
        return requested === "read" || requested === "read-write";
    }

    #requireAccess(path: string, required: ConfigPathPermission): void {
        const requested = this.#access[path];
        if (!allows(requested, required)) {
            throw new Error(
                `Extension ${this.#extensionId} is not authorized for ${required} Core Config access to ${path}.`,
            );
        }
        const parsed = parseConfigPath(path);
        const definition = this.#registry.require(parsed.domain);
        if (definition.owner.kind !== "core") {
            throw new Error(
                `Core Config capability cannot access non-Core path ${path}.`,
            );
        }
        const exported = definition.exports?.[parsed.relative];
        if (!allows(exported, required)) {
            throw new Error(
                `Config path ${path} does not export ${required} access.`,
            );
        }
    }
}

export function extensionConfigDomainDefinition(
    extensionId: string,
    generation: string,
    declaration: ExtensionConfigDeclaration,
): ConfigDomainDefinition | undefined {
    if (declaration.default === undefined || declaration.schema === undefined)
        return undefined;
    return {
        defaultValue: declaration.default as Readonly<
            Record<string, JsonValue>
        >,
        id: extensionId,
        owner: { extensionId, generation, kind: "extension" },
        schema: declaration.schema as
            boolean | Readonly<Record<string, JsonValue>>,
    };
}

export function assertExtensionCoreConfigAccess(
    extensionId: string,
    registry: ConfigRegistry,
    access: Readonly<Record<string, ExtensionCoreConfigAccess>>,
): void {
    for (const [path, requested] of Object.entries(access)) {
        const parsed = parseConfigPath(path);
        if (parsed.domain === extensionId) {
            throw new TypeError(
                `Extension ${extensionId} must not request Core Config access to its own path ${path}.`,
            );
        }
        const definition = registry.require(parsed.domain);
        if (definition.owner.kind !== "core") {
            throw new TypeError(
                `Extension Core Config access supports Core-owned domains only: ${path}.`,
            );
        }
        const exported = definition.exports?.[parsed.relative];
        if (!allows(exported, requested)) {
            throw new TypeError(
                `Config path ${path} does not export requested ${requested} access.`,
            );
        }
    }
}

function publishChange(
    paths: readonly string[],
    listeners: ReadonlySet<(change: ExtensionConfigChange) => void>,
): void {
    if (paths.length === 0) return;
    const publicChange: ExtensionConfigChange = Object.freeze({
        paths: Object.freeze([...paths]),
    });
    for (const listener of [...listeners]) {
        try {
            listener(publicChange);
        } catch {
            // Config is already committed; observers cannot roll it back.
        }
    }
}

function allows(
    granted: ConfigPathPermission | ExtensionCoreConfigAccess | undefined,
    required: ConfigPathPermission | ExtensionCoreConfigAccess,
): boolean {
    if (granted === undefined) return false;
    if (required === "read")
        return granted === "read" || granted === "read-write";
    return granted === "read-write";
}
