export type ConfigDomainOwner =
    | { readonly kind: "core" }
    | { readonly extensionId: string; readonly kind: "extension" };

export interface ConfigDomainDefinition {
    readonly id: string;
    readonly owner: ConfigDomainOwner;
}

export class ConfigRegistry {
    readonly #domains = new Map<string, ConfigDomainDefinition>();

    constructor(definitions: readonly ConfigDomainDefinition[] = []) {
        for (const definition of definitions) this.register(definition);
    }

    register(definition: ConfigDomainDefinition): void {
        assertDomainId(definition.id);
        const existing = this.#domains.get(definition.id);
        if (existing !== undefined) {
            throw new Error(
                `Config domain ${definition.id} is already registered by ${formatOwner(existing.owner)}.`,
            );
        }
        if (definition.owner.kind === "extension") {
            assertDomainId(definition.owner.extensionId);
        }
        this.#domains.set(
            definition.id,
            Object.freeze({
                id: definition.id,
                owner: Object.freeze({ ...definition.owner }),
            }),
        );
    }

    get(id: string): ConfigDomainDefinition | undefined {
        return this.#domains.get(id);
    }

    has(id: string): boolean {
        return this.#domains.has(id);
    }

    list(): readonly ConfigDomainDefinition[] {
        return Object.freeze(
            [...this.#domains.values()].sort((left, right) =>
                left.id.localeCompare(right.id),
            ),
        );
    }

    require(id: string): ConfigDomainDefinition {
        const definition = this.#domains.get(id);
        if (definition !== undefined) return definition;
        throw new Error(`Config domain ${id} is not registered.`);
    }
}

export function createCoreConfigRegistry(): ConfigRegistry {
    return new ConfigRegistry([
        { id: "control", owner: { kind: "core" } },
        { id: "mcp", owner: { kind: "core" } },
        { id: "web", owner: { kind: "core" } },
    ]);
}

function assertDomainId(id: string): void {
    if (/^[a-z][a-z0-9-]*$/u.test(id)) return;
    throw new TypeError(
        `Config domain id ${JSON.stringify(id)} must match [a-z][a-z0-9-]*.`,
    );
}

function formatOwner(owner: ConfigDomainOwner): string {
    return owner.kind === "core" ? "core" : `extension:${owner.extensionId}`;
}
