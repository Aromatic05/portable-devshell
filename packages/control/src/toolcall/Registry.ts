import {
    type ToolCallHookContributor,
    type ToolCallHooks,
    type ToolCallRegistration,
    type ToolCallReviewHook,
    type ToolCallExecutor,
    type ToolNameHandle,
} from "@portable-devshell/core/toolcall";
import { toolNamespace, type ToolDefinition } from "@portable-devshell/shared";
import type {
    ToolCallDefinitionEntry,
    ToolCallDefinitionRegistration,
    ToolCallRegistry,
} from "./Api.js";

export const allToolCallInstances = "*" as const;

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
