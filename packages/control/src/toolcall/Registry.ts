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

export class ToolCallRegistryState implements ToolCallRegistry {
    #hooks?: ToolCallHooks;
    readonly #registrations = new Map<symbol, StoredRegistration>();

    bind(hooks: ToolCallHooks): () => void {
        if (this.#hooks !== undefined)
            throw new Error("Control ToolCall registry is already bound.");
        this.#hooks = hooks;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (this.#hooks === hooks) this.#hooks = undefined;
        };
    }

    registerContributor(contributor: ToolCallHookContributor): () => void {
        return this.#requireHooks().registerContributor(contributor);
    }

    registerExecute(toolName: string, execute: ToolCallExecutor): () => void {
        return this.#requireHooks().registerExecute(toolName, execute);
    }

    registerReview(review: ToolCallReviewHook): () => void {
        return this.#requireHooks().registerReview(review);
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
        let disposed = false;
        return {
            dispose: () => {
                if (disposed) return;
                disposed = true;
                this.#registrations.delete(id);
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
                registration.definitions = replacement.definitions;
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

    #requireHooks(): ToolCallHooks {
        if (this.#hooks !== undefined) return this.#hooks;
        throw new Error("Control ToolCall registry is not bound.");
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

export interface InstanceToolCatalogSource {
    readonly config: { readonly mcpEnabled: boolean; readonly name: string };
    readonly toolDefinitions: {
        list(): readonly ToolDefinition[];
        onChange(listener: () => void): () => void;
    };
}

export interface InstallInstanceToolDefinitionsOptions {
    changes: { onChange(listener: () => void): () => void };
    hooks: ToolCallRegistry;
    instances: { list(): readonly InstanceToolCatalogSource[] };
}

/**
 * Projects every MCP-enabled instance's per-instance tool catalog into the
 * Control registry, scoped by instance name. The catalog is the single source
 * of truth for Worker-refreshed definitions, so registering it here keeps the
 * MCP catalog consistent without copying Worker schemas.
 */
export function installInstanceToolDefinitions(
    options: InstallInstanceToolDefinitionsOptions,
): () => void {
    const { changes, hooks, instances } = options;
    const registrations = new Map<
        string,
        {
            readonly instance: InstanceToolCatalogSource;
            readonly registration: ToolCallDefinitionRegistration;
            readonly unsubscribe: () => void;
        }
    >();
    const sync = () => {
        const active = new Map<string, InstanceToolCatalogSource>();
        for (const instance of instances.list()) {
            if (instance.config.mcpEnabled)
                active.set(instance.config.name, instance);
        }
        for (const [name, entry] of registrations) {
            if (active.get(name) === entry.instance) continue;
            entry.unsubscribe();
            entry.registration.dispose();
            registrations.delete(name);
        }
        for (const [name, instance] of active) {
            if (registrations.has(name)) continue;
            const registration = hooks.register(
                name,
                instance.toolDefinitions.list(),
            );
            const unsubscribe = instance.toolDefinitions.onChange(() => {
                registration.replace(instance.toolDefinitions.list());
            });
            registrations.set(name, { instance, registration, unsubscribe });
        }
    };
    sync();
    const stopSync = changes.onChange(sync);
    return () => {
        stopSync();
        for (const entry of registrations.values()) {
            entry.unsubscribe();
            entry.registration.dispose();
        }
        registrations.clear();
    };
}
