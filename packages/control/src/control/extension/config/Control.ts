import { join } from "node:path";

import type {
    ExtensionConfig,
    ExtensionConfigAccess,
    ExtensionConfigChange,
    ExtensionConfigDeclaration,
    ExtensionJsonValue,
} from "@portable-devshell/extension";
import type { ControlConfig, JsonValue } from "@portable-devshell/shared";

import { ConfigChangeHub, type ConfigCommittedChange } from "../../config/Change.js";
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

export interface ExtensionConfigRuntime extends ExtensionConfig {
    close(): void;
    validate(): Promise<void>;
}

export class ExtensionConfigControl implements ExtensionConfigRuntime {
    readonly #access: Readonly<Record<string, ExtensionConfigAccess>>;
    readonly #changeHub: ConfigChangeHub;
    readonly #controller?: ConfigDomainController;
    readonly #extensionId: string;
    readonly #listeners = new Set<(change: ExtensionConfigChange) => void>();
    readonly #readCoreConfig: () => ControlConfig;
    readonly #registry: ConfigRegistry;
    readonly #unsubscribeChanges: () => void;
    readonly #updateCoreConfig: ExtensionConfigControlOptions["updateCoreConfig"];

    constructor(options: ExtensionConfigControlOptions) {
        this.#access = Object.freeze({ ...(options.declaration.access ?? {}) });
        this.#changeHub = options.changeHub;
        this.#extensionId = options.extensionId;
        this.#readCoreConfig = options.readCoreConfig;
        this.#registry = options.registry;
        this.#updateCoreConfig = options.updateCoreConfig;
        const definition = extensionConfigDomainDefinition(
            options.extensionId,
            options.generation,
            options.declaration,
        );
        this.#controller =
            definition === undefined
                ? undefined
                : new ConfigDomainController({
                      definition,
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
        const parsed = parseConfigPath(path);
        if (parsed.domain === this.#extensionId) {
            if (this.#controller === undefined) {
                throw new Error(
                    `Extension ${this.#extensionId} does not own a Config domain.`,
                );
            }
            const current = await this.#controller.read();
            return getConfigPathValue(current, parsed.segments) as
                | ExtensionJsonValue
                | undefined;
        }
        this.#requireAccess(path, "read");
        const definition = this.#registry.require(parsed.domain);
        if (definition.owner.kind !== "core") {
            throw new Error(
                `Cross-Extension Config reads are not supported for ${path}.`,
            );
        }
        const config = this.#readCoreConfig() as unknown as Record<
            string,
            JsonValue
        >;
        return getConfigPathValue(config[parsed.domain], parsed.segments) as
            | ExtensionJsonValue
            | undefined;
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
        const ownedEntries: [string, ExtensionJsonValue][] = [];
        const coreEntries: [string, ExtensionJsonValue][] = [];
        for (const [path] of entries) {
            const parsed = parseConfigPath(path);
            if (parsed.domain === this.#extensionId) {
                ownedEntries.push([path, patch[path]!]);
            } else {
                this.#requireAccess(path, "read-write");
                coreEntries.push([path, patch[path]!]);
            }
        }
        if (ownedEntries.length > 0 && coreEntries.length > 0) {
            throw new Error(
                "One Config update cannot mix Extension-owned and Core-owned domains.",
            );
        }
        if (coreEntries.length > 0) {
            await this.#updateCoreConfig(
                Object.fromEntries(coreEntries) as Readonly<
                    Record<string, JsonValue>
                >,
            );
            return;
        }
        if (this.#controller === undefined) {
            throw new Error(
                `Extension ${this.#extensionId} does not own a Config domain.`,
            );
        }
        const result = await this.#controller.update((current) => {
            const next = structuredClone(current) as Record<string, JsonValue>;
            for (const [path, value] of ownedEntries) {
                const parsed = parseConfigPath(path);
                setConfigPathValue(
                    next,
                    parsed.segments,
                    value as JsonValue,
                );
            }
            return next;
        });
        this.#changeHub.publish(
            diffConfigPaths(
                result.previous,
                result.next,
                this.#extensionId,
            ),
        );
    }

    async validate(): Promise<void> {
        for (const [path, requested] of Object.entries(this.#access)) {
            const parsed = parseConfigPath(path);
            if (parsed.domain === this.#extensionId) {
                throw new TypeError(
                    `Extension ${this.#extensionId} must not request access to its own Config path ${path}.`,
                );
            }
            const definition = this.#registry.require(parsed.domain);
            if (definition.owner.kind !== "core") {
                throw new TypeError(
                    `Extension Config access currently supports Core-owned domains only: ${path}.`,
                );
            }
            const exported = definition.exports?.[parsed.relative];
            if (!allows(exported, requested)) {
                throw new TypeError(
                    `Config path ${path} does not export requested ${requested} access.`,
                );
            }
        }
        if (this.#controller !== undefined) await this.#controller.read();
    }

    #acceptChange(change: ConfigCommittedChange): void {
        const paths = change.paths.filter((path) => this.#canRead(path));
        if (paths.length === 0) return;
        const publicChange: ExtensionConfigChange = Object.freeze({
            paths: Object.freeze([...paths]),
        });
        for (const listener of [...this.#listeners]) {
            try {
                listener(publicChange);
            } catch {
                // Config is already committed; observers cannot roll it back.
            }
        }
    }

    #canRead(path: string): boolean {
        const parsed = parseConfigPath(path);
        if (parsed.domain === this.#extensionId)
            return this.#controller !== undefined;
        const requested = this.#access[path];
        return requested === "read" || requested === "read-write";
    }

    #requireAccess(path: string, required: ConfigPathPermission): void {
        const requested = this.#access[path];
        if (!allows(requested, required)) {
            throw new Error(
                `Extension ${this.#extensionId} is not authorized for ${required} Config access to ${path}.`,
            );
        }
        const parsed = parseConfigPath(path);
        const exported = this.#registry.require(parsed.domain).exports?.[
            parsed.relative
        ];
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
        defaultValue: declaration.default as Readonly<Record<string, JsonValue>>,
        id: extensionId,
        owner: { extensionId, generation, kind: "extension" },
        schema: declaration.schema as
            | boolean
            | Readonly<Record<string, JsonValue>>,
    };
}

export function assertExtensionConfigAccess(
    extensionId: string,
    registry: ConfigRegistry,
    declaration: ExtensionConfigDeclaration,
): void {
    for (const [path, requested] of Object.entries(declaration.access ?? {})) {
        const parsed = parseConfigPath(path);
        if (parsed.domain === extensionId) {
            throw new TypeError(
                `Extension ${extensionId} must not request access to its own Config path ${path}.`,
            );
        }
        const definition = registry.require(parsed.domain);
        if (definition.owner.kind !== "core") {
            throw new TypeError(
                `Extension Config access currently supports Core-owned domains only: ${path}.`,
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

function allows(
    granted: ConfigPathPermission | ExtensionConfigAccess | undefined,
    required: ConfigPathPermission | ExtensionConfigAccess,
): boolean {
    if (granted === undefined) return false;
    if (required === "read")
        return granted === "read" || granted === "read-write";
    return granted === "read-write";
}
