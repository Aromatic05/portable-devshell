import type {
    ToolCallHooks,
    ToolCallRegistration,
} from "@portable-devshell/core/toolcall";
import { toolNamespace, type ToolDefinition } from "@portable-devshell/shared";
import type {
    McpToolSource,
    McpToolSourceEntry,
} from "../../src/endpoint/tool/Source.ts";

export const allTestToolInstances = "*" as const;

export interface TestToolRegistration {
    replace(definitions: readonly ToolDefinition[]): void;
    dispose(): void;
}

interface StoredRegistration {
    definitions: Map<string, ToolDefinition>;
    readonly id: symbol;
    readonly scope: string;
}

export class TestToolSource implements McpToolSource {
    readonly #registrations = new Map<symbol, StoredRegistration>();

    register(
        scope: string,
        definitions: readonly ToolDefinition[],
    ): TestToolRegistration {
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
                    throw new Error("Test tool registration is already disposed.");
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

    registration(hooks: ToolCallHooks): ToolCallRegistration {
        return {
            registerContributor: (contributor) =>
                hooks.registerContributor(contributor),
            registerExecute: (toolName, execute) =>
                hooks.registerExecute(toolName, execute),
            registerReview: (review) => hooks.registerReview(review),
            registerToolName: (toolName, handle) => {
                const definition = handle();
                if (definition.name !== toolName)
                    throw new Error(
                        `Tool definition ${definition.name} does not match registered name ${toolName}.`,
                    );
                const registration = this.register(allTestToolInstances, [
                    definition,
                ]);
                return () => registration.dispose();
            },
        };
    }

    list(instance: string): readonly McpToolSourceEntry[] {
        validateInstance(instance);
        const entries: McpToolSourceEntry[] = [];
        for (const registration of this.#registrations.values()) {
            if (
                registration.scope !== allTestToolInstances &&
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

    get(instance: string, toolName: string): McpToolSourceEntry | undefined {
        return this.list(instance).find(
            (entry) => entry.definition.name === toolName,
        );
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
    if (scope === allTestToolInstances) return;
    validateInstance(scope);
}

function validateInstance(instance: string): void {
    if (instance.length === 0 || instance === allTestToolInstances)
        throw new Error("Tool source instance must be a non-empty instance name.");
}

function scopesOverlap(left: string, right: string): boolean {
    return (
        left === allTestToolInstances ||
        right === allTestToolInstances ||
        left === right
    );
}
