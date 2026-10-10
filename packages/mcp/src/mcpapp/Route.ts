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
    readonly #pathPrefix: string;
    #closed = false;
    readonly #live = new Map<string, ReturnType<typeof installMcpAppLive>>();

    constructor(host: McpHttpRoute, runtime: McpAppRuntime,
        contexts: Pick<ContextTransport, 'validateForInstance'>, publicBaseUrl?: string) {
        this.#host = host;
        this.#runtime = runtime;
        this.#contexts = contexts;
        this.#pathPrefix = publicBaseUrl === undefined ? '' : new URL(publicBaseUrl).pathname.replace(/\/+$/u, '');
        const path = `${this.#pathPrefix}/mcpapp/assets`;
        const removeCors = this.#host.registerMiddleware(path, (_request, response, next) => {
            response.setHeader('Access-Control-Allow-Origin', '*');
            next();
        });
        try {
            const removeAssets = this.#host.registerStaticDirectory(path, mcpAppAssetDirectory);
            this.#unregisterAssets = () => {
                const failures: unknown[] = [];
                try { removeAssets(); } catch (error) { failures.push(error); }
                try { removeCors(); } catch (error) { failures.push(error); }
                if (failures.length > 0) throw new AggregateError(failures, 'MCP App asset cleanup failed');
            };
        } catch (error) {
            try { removeCors(); }
            catch (cleanupError) { throw new AggregateError([error, cleanupError], 'MCP App asset registration rollback failed'); }
            throw error;
        }
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
            pathPrefix: this.#pathPrefix,
        }));
    }

    unregister(instance: string): void {
        this.#live.get(instance)?.();
        this.#live.delete(instance);
    }

    stop(): void {
        const errors: unknown[] = [];
        for (const instance of [...this.#live.keys()]) {
            try { this.unregister(instance); }
            catch (error) { errors.push(error); }
        }
        if (errors.length > 0) throw new AggregateError(errors, 'MCP App Live route cleanup failed');
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        const errors: unknown[] = [];
        try { this.stop(); } catch (error) { errors.push(error); }
        try { this.#unregisterAssets(); } catch (error) { errors.push(error); }
        if (errors.length > 0) throw new AggregateError(errors, 'MCP App route cleanup failed');
    }

    revokeContext(ctxId: string): void {
        for (const route of this.#live.values()) route.revokeContext(ctxId);
    }

    has(instance: string): boolean { return this.#live.has(instance); }
}
