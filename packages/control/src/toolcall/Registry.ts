import {
    toolNamespace,
    type ToolCallExecutor,
    type ToolCallHookContributor,
    type ToolCallHooks,
    type ToolCallReviewHook,
    type ToolDefinition,
    type ToolNameHandle,
} from "@portable-devshell/shared";
import type {
    InstanceToolCatalogSource,
    ToolCallDefinitionEntry,
    ToolCallDefinitionRegistration,
    ToolCallRegistry,
} from "./Api.js";

const allToolCallInstances = "*" as const;

interface StoredRegistration {
    definitions: Map<string, ToolDefinition>;
    readonly id: symbol;
    readonly scope: string;
}

interface HookRegistration {
    install(hooks: ToolCallHooks): () => void;
    releases: Map<InstanceToolCatalogSource, () => void>;
}

interface ExecuteRegistration {
    execute: ToolCallExecutor;
    releases: Map<InstanceToolCatalogSource, () => void>;
}

interface InstanceBinding {
    instance: InstanceToolCatalogSource;
    definitions: ToolCallDefinitionRegistration;
    current: readonly ToolDefinition[];
}

export class ToolCallRegistryState implements ToolCallRegistry {
    readonly #registrations = new Map<symbol, StoredRegistration>();
    readonly #hooks = new Set<HookRegistration>();
    readonly #executes = new Map<string, ExecuteRegistration>();
    readonly #bindings = new Map<string, InstanceBinding>();
    #bound = false;

    bind(options: {
        changes: { onChange(listener: () => void): () => void };
        instances: { list(): readonly InstanceToolCatalogSource[] };
    }): () => void {
        if (this.#bound) throw new Error("ToolCall registry is already bound.");
        this.#bound = true;
        let stop: () => void;
        try {
            this.#sync(options.instances.list());
            stop = options.changes.onChange(() => this.#sync(options.instances.list()));
        } catch (error) {
            this.#detachAll();
            this.#bound = false;
            throw error;
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            stop();
            this.#detachAll();
            this.#bound = false;
        };
    }

    registerContributor(contributor: ToolCallHookContributor): () => void {
        return this.#registerHook((hooks) => hooks.registerContributor(contributor));
    }

    registerExecute(toolName: string, execute: ToolCallExecutor): () => void {
        if (this.#executes.has(toolName))
            throw new Error(`ToolCall execute already registered: ${toolName}`);
        const entry: ExecuteRegistration = { execute, releases: new Map() };
        this.#executes.set(toolName, entry);
        try {
            this.#syncExecutes();
        } catch (error) {
            this.#executes.delete(toolName);
            this.#syncExecutes();
            throw error;
        }
        return () => {
            this.#executes.delete(toolName);
            for (const release of entry.releases.values()) release();
            entry.releases.clear();
        };
    }

    registerReview(review: ToolCallReviewHook): () => void {
        return this.#registerHook((hooks) => hooks.registerReview(review));
    }

    registerToolName(toolName: string, handle: ToolNameHandle): () => void {
        const definition = handle();
        if (definition.name !== toolName)
            throw new Error(
                `Tool definition ${definition.name} does not match registered name ${toolName}.`,
            );
        const registration = this.register(allToolCallInstances, [definition]);
        return () => registration.dispose();
    }

    register(
        scope: string,
        definitions: readonly ToolDefinition[],
    ): ToolCallDefinitionRegistration {
        validateScope(scope);
        const id = Symbol(scope);
        const registration: StoredRegistration = {
            definitions: normalizeDefinitions(definitions),
            id,
            scope,
        };
        this.#assertNoConflicts(registration);
        this.#registrations.set(id, registration);
        try {
            this.#refreshDefinitions();
        } catch (error) {
            this.#registrations.delete(id);
            this.#refreshDefinitions();
            throw error;
        }
        let disposed = false;
        return {
            dispose: () => {
                if (disposed) return;
                disposed = true;
                this.#registrations.delete(id);
                this.#refreshDefinitions();
            },
            replace: (next) => {
                if (disposed)
                    throw new Error("ToolCall definition registration is already disposed.");
                const replacement: StoredRegistration = {
                    definitions: normalizeDefinitions(next),
                    id,
                    scope,
                };
                this.#assertNoConflicts(replacement, id);
                const previous = registration.definitions;
                registration.definitions = replacement.definitions;
                try {
                    this.#refreshDefinitions();
                } catch (error) {
                    registration.definitions = previous;
                    this.#refreshDefinitions();
                    throw error;
                }
            },
        };
    }

    registerAll(
        definitions: readonly ToolDefinition[],
    ): ToolCallDefinitionRegistration {
        return this.register(allToolCallInstances, definitions);
    }

    list(instance: string): readonly ToolCallDefinitionEntry[] {
        validateInstance(instance);
        const entries: ToolCallDefinitionEntry[] = [];
        for (const registration of this.#registrations.values()) {
            if (
                registration.scope !== allToolCallInstances &&
                registration.scope !== instance
            )
                continue;
            for (const definition of registration.definitions.values()) {
                entries.push({
                    definition: structuredClone(definition),
                    scope: registration.scope,
                });
            }
        }
        const source = this.#bindings.get(instance)?.instance;
        if (source?.config.mcpEnabled) {
            const registered = new Set(entries.map((entry) => entry.definition.name));
            for (const definition of source.toolDefinitions.list()) {
                if (registered.has(definition.name)) continue;
                entries.push({ definition: structuredClone(definition), scope: instance });
            }
        }
        return entries;
    }

    get(
        instance: string,
        toolName: string,
    ): ToolCallDefinitionEntry | undefined {
        return this.list(instance).find(
            (entry) => entry.definition.name === toolName,
        );
    }

    #registerHook(install: HookRegistration["install"]): () => void {
        const entry: HookRegistration = { install, releases: new Map() };
        try {
            for (const binding of this.#bindings.values())
                entry.releases.set(binding.instance, install(binding.instance.toolCallHooks));
        } catch (error) {
            for (const release of entry.releases.values()) release();
            throw error;
        }
        this.#hooks.add(entry);
        let disposed = false;
        return () => {
            if (disposed) return;
            disposed = true;
            this.#hooks.delete(entry);
            for (const release of entry.releases.values()) release();
            entry.releases.clear();
        };
    }

    #definitions(instance: string): readonly ToolDefinition[] {
        const definitions: ToolDefinition[] = [];
        for (const registration of this.#registrations.values()) {
            if (registration.scope !== allToolCallInstances && registration.scope !== instance)
                continue;
            definitions.push(...registration.definitions.values());
        }
        return definitions;
    }

    #refreshDefinitions(): void {
        const updated: InstanceBinding[] = [];
        try {
            for (const [name, binding] of this.#bindings) {
                binding.definitions.replace(this.#definitions(name));
                updated.push(binding);
            }
            this.#syncExecutes();
        } catch (error) {
            for (const binding of updated.reverse())
                binding.definitions.replace(binding.current);
            this.#syncExecutes();
            throw error;
        }
        for (const [name, binding] of this.#bindings)
            binding.current = this.#definitions(name);
    }

    #syncExecutes(): void {
        for (const [name, binding] of this.#bindings) {
            const visible = new Set(this.#definitions(name).map((definition) => definition.name));
            for (const [toolName, entry] of this.#executes) {
                const installed = entry.releases.get(binding.instance);
                if (!visible.has(toolName)) {
                    installed?.();
                    entry.releases.delete(binding.instance);
                } else if (installed === undefined) {
                    entry.releases.set(
                        binding.instance,
                        binding.instance.toolCallHooks.registerExecute(toolName, entry.execute),
                    );
                }
            }
        }
    }

    #sync(instances: readonly InstanceToolCatalogSource[]): void {
        const active = new Map(instances.map((instance) => [instance.config.name, instance]));
        for (const [name, binding] of this.#bindings) {
            if (active.get(name) === binding.instance) continue;
            this.#detach(name, binding);
        }
        for (const [name, instance] of active) {
            if (this.#bindings.has(name)) continue;
            const current = this.#definitions(name);
            const definitions = instance.toolDefinitions.register(current);
            try {
                for (const hook of this.#hooks)
                    hook.releases.set(instance, hook.install(instance.toolCallHooks));
                for (const [toolName, entry] of this.#executes) {
                    if (!current.some((definition) => definition.name === toolName)) continue;
                    entry.releases.set(instance, instance.toolCallHooks.registerExecute(toolName, entry.execute));
                }
            } catch (error) {
                for (const hook of this.#hooks) {
                    hook.releases.get(instance)?.();
                    hook.releases.delete(instance);
                }
                for (const entry of this.#executes.values()) {
                    entry.releases.get(instance)?.();
                    entry.releases.delete(instance);
                }
                definitions.dispose();
                throw error;
            }
            this.#bindings.set(name, { instance, definitions, current });
        }
    }

    #detach(name: string, binding: InstanceBinding): void {
        for (const hook of this.#hooks) {
            hook.releases.get(binding.instance)?.();
            hook.releases.delete(binding.instance);
        }
        for (const entry of this.#executes.values()) {
            entry.releases.get(binding.instance)?.();
            entry.releases.delete(binding.instance);
        }
        binding.definitions.dispose();
        this.#bindings.delete(name);
    }

    #detachAll(): void {
        for (const [name, binding] of this.#bindings)
            this.#detach(name, binding);
    }

    #assertNoConflicts(
        candidate: StoredRegistration,
        replacing?: symbol,
    ): void {
        for (const current of this.#registrations.values()) {
            if (
                current.id === replacing ||
                !scopesOverlap(current.scope, candidate.scope)
            )
                continue;
            for (const toolName of candidate.definitions.keys()) {
                if (!current.definitions.has(toolName)) continue;
                throw new Error(
                    `Tool ${toolName} is registered more than once for overlapping scopes ${current.scope} and ${candidate.scope}.`,
                );
            }
        }
    }
}

function normalizeDefinitions(
    definitions: readonly ToolDefinition[],
): Map<string, ToolDefinition> {
    const normalized = new Map<string, ToolDefinition>();
    for (const definition of definitions) {
        validateDefinition(definition);
        if (normalized.has(definition.name))
            throw new Error(
                `Tool ${definition.name} is registered more than once in the same registration.`,
            );
        normalized.set(definition.name, structuredClone(definition));
    }
    return normalized;
}

function validateDefinition(definition: ToolDefinition): void {
    const namespace = toolNamespace(definition.name);
    if (namespace === undefined || definition.group !== namespace)
        throw new Error(
            `Tool ${definition.name} group ${definition.group} must match its namespace.`,
        );
}

function validateScope(scope: string): void {
    if (scope === allToolCallInstances) return;
    validateInstance(scope);
}

function validateInstance(instance: string): void {
    if (instance.length === 0 || instance === allToolCallInstances)
        throw new Error("ToolCall instance scope must be a non-empty instance name.");
}

function scopesOverlap(left: string, right: string): boolean {
    return (
        left === allToolCallInstances ||
        right === allToolCallInstances ||
        left === right
    );
}

export interface InstallInstanceToolDefinitionsOptions {
    changes: { onChange(listener: () => void): () => void };
    hooks: ToolCallRegistry;
    instances: { list(): readonly InstanceToolCatalogSource[] };
}

/** Install Control registrations into every live Instance and project its catalog to MCP. */
export function installInstanceToolDefinitions(
    options: InstallInstanceToolDefinitionsOptions,
): () => void {
    return options.hooks.bind({ changes: options.changes, instances: options.instances });
}
