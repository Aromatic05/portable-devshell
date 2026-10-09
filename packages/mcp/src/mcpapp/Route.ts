import type { ContextTransport } from '@portable-devshell/shared';
import type { McpHttpRoute } from '../server/Api.js';
import { mcpAppAssetDirectory } from './app/Resource.js';
import { installMcpAppLive } from './app/Live.js';
import type { McpAppRuntime } from './index.js';

/** Owns the MCP App's public assets and per-Instance Live HTTP registrations. */
export class McpAppRoute {
    readonly #host: McpHttpRoute;
    readonly #runtime: McpAppRuntime;
    readonly #contexts: Pick<ContextTransport, 'validateForInstance'>;
    readonly #unregisterAssets: () => void;
    #closed = false;
    readonly #live = new Map<string, ReturnType<typeof installMcpAppLive>>();

    constructor(host: McpHttpRoute, runtime: McpAppRuntime,
        contexts: Pick<ContextTransport, 'validateForInstance'>) {
        this.#host = host;
        this.#runtime = runtime;
        this.#contexts = contexts;
        const removeCors = this.#host.registerMiddleware('/mcpapp/assets', (_request, response, next) => {
            response.setHeader('Access-Control-Allow-Origin', '*');
            next();
        });
        const removeAssets = this.#host.registerStaticDirectory('/mcpapp/assets', mcpAppAssetDirectory);
        this.#unregisterAssets = () => { removeAssets(); removeCors(); };
    }

    register(instance: string): void {
        if (this.#closed) throw new Error('MCP App Route is closed.');
        if (this.#live.has(instance)) return;
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

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.stop();
        this.#unregisterAssets();
    }

    revokeContext(ctxId: string): void {
        for (const route of this.#live.values()) route.revokeContext(ctxId);
    }

    has(instance: string): boolean { return this.#live.has(instance); }
}
