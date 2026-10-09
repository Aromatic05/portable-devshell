import type { ContextTransport } from '@portable-devshell/shared';
import type { HttpHost } from '../host/Http.js';
import { mcpAppAssetDirectory } from './app/Resource.js';
import { installMcpAppLive } from './app/Live.js';
import type { McpAppRuntime } from './index.js';

/** Owns the MCP App's public assets and per-Instance Live HTTP registrations. */
export class McpAppRoute {
    readonly #host: HttpHost;
    readonly #runtime: McpAppRuntime;
    readonly #contexts: Pick<ContextTransport, 'validateForInstance'>;
    readonly #live = new Map<string, () => void>();

    constructor(host: HttpHost, runtime: McpAppRuntime,
        contexts: Pick<ContextTransport, 'validateForInstance'>) {
        this.#host = host;
        this.#runtime = runtime;
        this.#contexts = contexts;
        this.#host.registerStaticDirectory('/mcpapp/assets', mcpAppAssetDirectory);
    }

    register(instance: string): void {
        this.unregister(instance);
        if (this.#runtime.view === undefined) return;
        this.#live.set(instance, installMcpAppLive({
            contexts: this.#contexts,
            host: this.#host,
            instance,
            leases: this.#runtime.leases,
            presence: this.#runtime.presence,
            view: this.#runtime.view,
        }));
    }

    unregister(instance: string): void {
        this.#live.get(instance)?.();
        this.#live.delete(instance);
    }

    stop(): void {
        for (const instance of this.#live.keys()) this.unregister(instance);
    }

    has(instance: string): boolean { return this.#live.has(instance); }
}
