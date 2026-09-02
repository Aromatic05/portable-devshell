import type { AgentProvider } from "../provider/AgentProvider.js";

export class AgentProviderRegistry {
    readonly #providers = new Map<string, AgentProvider>();

    constructor(providers: readonly AgentProvider[] = []) {
        for (const provider of providers) {
            this.register(provider);
        }
    }

    register(provider: AgentProvider): void {
        assertProviderId(provider.id);
        if (this.#providers.has(provider.id)) {
            throw new Error(`Agent provider already registered: ${provider.id}`);
        }
        this.#providers.set(provider.id, provider);
    }

    get(id: string): AgentProvider | undefined {
        return this.#providers.get(id);
    }

    require(id: string): AgentProvider {
        const provider = this.get(id);
        if (provider === undefined) {
            throw new Error(`Unknown Agent provider: ${id}`);
        }
        return provider;
    }

    list(): readonly AgentProvider[] {
        return [...this.#providers.values()];
    }
}

function assertProviderId(id: string): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
        throw new TypeError(`Invalid Agent provider id: ${id}`);
    }
}
