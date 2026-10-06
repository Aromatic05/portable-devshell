import { toolNamespace, type ToolDefinition } from "@portable-devshell/shared";

export interface InstanceToolDefinitionRegistration {
    replace(definitions: readonly ToolDefinition[]): void;
    dispose(): void;
}

interface StoredToolDefinitionRegistration {
    definitions: Map<string, ToolDefinition>;
    readonly id: symbol;
}

/**
 * Per-instance catalog of the tool definitions exposed to that instance.
 * The instance state owns one catalog; the worker tool refresh and
 * host-provided tools (for example artifact tools) each register their
 * definitions here and consumers read the merged view.
 */
export class InstanceToolCatalog {
    readonly #registrations = new Map<
        symbol,
        StoredToolDefinitionRegistration
    >();

    register(
        definitions: readonly ToolDefinition[],
    ): InstanceToolDefinitionRegistration {
        const id = Symbol("instance-tool-definitions");
        const registration: StoredToolDefinitionRegistration = {
            definitions: normalizeToolDefinitions(definitions),
            id,
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
                    throw new Error(
                        "Instance tool definition registration is already disposed.",
                    );
                const replacement: StoredToolDefinitionRegistration = {
                    definitions: normalizeToolDefinitions(next),
                    id,
                };
                this.#assertNoConflicts(replacement, id);
                registration.definitions = replacement.definitions;
            },
        };
    }

    list(): readonly ToolDefinition[] {
        const definitions: ToolDefinition[] = [];
        for (const registration of this.#registrations.values())
            definitions.push(...registration.definitions.values());
        return definitions;
    }

    #assertNoConflicts(
        candidate: StoredToolDefinitionRegistration,
        replacing?: symbol,
    ): void {
        for (const current of this.#registrations.values()) {
            if (current.id === replacing) continue;
            for (const toolName of candidate.definitions.keys()) {
                if (!current.definitions.has(toolName)) continue;
                throw new Error(
                    `Tool ${toolName} is registered more than once in the instance catalog.`,
                );
            }
        }
    }
}

function normalizeToolDefinitions(
    definitions: readonly ToolDefinition[],
): Map<string, ToolDefinition> {
    const normalized = new Map<string, ToolDefinition>();
    for (const definition of definitions) {
        validateToolDefinition(definition);
        if (normalized.has(definition.name))
            throw new Error(
                `Tool ${definition.name} is registered more than once in the same registration.`,
            );
        normalized.set(definition.name, structuredClone(definition));
    }
    return normalized;
}

function validateToolDefinition(definition: ToolDefinition): void {
    const namespace = toolNamespace(definition.name);
    if (namespace === undefined || definition.group !== namespace)
        throw new Error(
            `Tool ${definition.name} group ${definition.group} must match its namespace.`,
        );
}
