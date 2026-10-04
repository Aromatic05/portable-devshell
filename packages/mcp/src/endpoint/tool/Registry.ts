import { toolNamespace, type ToolDefinition } from "@portable-devshell/shared";

export const mcpAllInstances = "*" as const;

export type McpToolRegistrationScope = string;

export interface McpToolRegistryEntry {
    definition: ToolDefinition;
    scope: McpToolRegistrationScope;
}

export interface McpToolRegistration {
    replace(definitions: readonly ToolDefinition[]): void;
    dispose(): void;
}

interface StoredRegistration {
    readonly id: symbol;
    definitions: Map<string, ToolDefinition>;
    readonly scope: McpToolRegistrationScope;
}

export class McpToolRegistry {
    readonly #registrations = new Map<symbol, StoredRegistration>();

    register(
        scope: McpToolRegistrationScope,
        definitions: readonly ToolDefinition[],
    ): McpToolRegistration {
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
                    throw new Error("MCP tool registration is already disposed.");
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

    list(instance: string): readonly McpToolRegistryEntry[] {
        validateInstance(instance);
        const entries: McpToolRegistryEntry[] = [];
        for (const registration of this.#registrations.values()) {
            if (
                registration.scope !== mcpAllInstances &&
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

    get(instance: string, toolName: string): McpToolRegistryEntry | undefined {
        return this.list(instance).find(
            (entry) => entry.definition.name === toolName,
        );
    }

    #assertNoConflicts(
        candidate: StoredRegistration,
        replacing?: symbol,
    ): void {
        for (const current of this.#registrations.values()) {
            if (current.id === replacing || !scopesOverlap(current.scope, candidate.scope))
                continue;
            for (const toolName of candidate.definitions.keys()) {
                if (!current.definitions.has(toolName)) continue;
                throw new Error(
                    `MCP tool ${toolName} is registered more than once for overlapping scopes ${current.scope} and ${candidate.scope}.`,
                );
            }
        }
    }
}

export const mcpTools = new McpToolRegistry();

function normalizeDefinitions(
    definitions: readonly ToolDefinition[],
): Map<string, ToolDefinition> {
    const normalized = new Map<string, ToolDefinition>();
    for (const definition of definitions) {
        validateDefinition(definition);
        if (normalized.has(definition.name))
            throw new Error(
                `MCP tool ${definition.name} is registered more than once in the same registration.`,
            );
        normalized.set(definition.name, structuredClone(definition));
    }
    return normalized;
}

function validateDefinition(definition: ToolDefinition): void {
    const namespace = toolNamespace(definition.name);
    if (namespace === undefined || definition.group !== namespace)
        throw new Error(
            `MCP tool ${definition.name} group ${definition.group} must match its namespace.`,
        );
}

function validateScope(scope: string): void {
    if (scope === mcpAllInstances) return;
    validateInstance(scope);
}

function validateInstance(instance: string): void {
    if (instance.length === 0 || instance === mcpAllInstances)
        throw new Error("MCP tool instance scope must be a non-empty instance name.");
}

function scopesOverlap(left: string, right: string): boolean {
    return (
        left === mcpAllInstances ||
        right === mcpAllInstances ||
        left === right
    );
}
