import type { McpAuthConfig } from '../oauth/Config.js';
import type { HttpHost } from '../host/Http.js';
import type { McpEndpointBinding } from './Binding.js';
import { McpHostRouteRegistry, type McpHostRouteEntry } from './Registry.js';

/** Owns the externally reachable MCP protocol bindings for one HTTP host. */
export class McpProtocolRoute {
    readonly #registry = new McpHostRouteRegistry();
    readonly #host: Pick<HttpHost, 'registerBinding' | 'unregisterBinding'>;
    #active = false;

    constructor(host: HttpHost) { this.#host = host; }

    register(entry: { binding: McpEndpointBinding; path: string; auth?: McpAuthConfig }): void {
        const previous = this.#registry.register(entry);
        if (!this.#active) return;
        if (previous !== undefined && previous.path !== entry.path)
            this.#host.unregisterBinding(previous.path);
        this.#host.registerBinding(entry.path, entry.binding, entry.auth);
    }

    unregister(instance: string): void {
        const previous = this.#registry.unregister(instance);
        if (this.#active && previous !== undefined)
            this.#host.unregisterBinding(previous.path);
    }

    start(): void {
        if (this.#active) return;
        for (const entry of this.#registry.list())
            this.#host.registerBinding(entry.path, entry.binding, entry.auth);
        this.#active = true;
    }

    stop(): void {
        if (!this.#active) return;
        this.#active = false;
        for (const entry of this.#registry.list()) this.#host.unregisterBinding(entry.path);
    }

    list(): McpHostRouteEntry[] { return this.#registry.list(); }
}
