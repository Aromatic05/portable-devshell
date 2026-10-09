import type { Endpoint } from '@portable-devshell/shared';
import { McpAppActionStore } from './ActionStore.js';
import { McpAppLeaseStore } from './app/Lease.js';
import { McpAppPresenceStore } from './app/Presence.js';
import { createMcpAppViewModel } from './ViewModel.js';

/** Owner for MCP App capabilities, durable action receipts, and presentation state. */
export class McpAppRuntime {
    readonly leases: McpAppLeaseStore;
    readonly actions: McpAppActionStore;
    readonly presence = new McpAppPresenceStore();
    readonly view?: ReturnType<typeof createMcpAppViewModel>;
    #initializePromise?: Promise<void>;

    constructor(options: { filePath?: string; endpoint?: Endpoint }) {
        this.leases = new McpAppLeaseStore({ filePath: options.filePath });
        this.actions = new McpAppActionStore({
            filePath: options.filePath === undefined ? undefined : `${options.filePath}.actions`,
        });
        this.view = options.endpoint === undefined ? undefined : createMcpAppViewModel(options.endpoint, this.actions);
    }

    async initialize(): Promise<void> {
        if (this.#initializePromise !== undefined) return await this.#initializePromise;
        const pending = Promise.all([this.leases.initialize(), this.actions.initialize()]).then(() => undefined);
        this.#initializePromise = pending;
        try { await pending; }
        catch (error) {
            if (this.#initializePromise === pending) this.#initializePromise = undefined;
            throw error;
        }
    }

    async revokeContext(ctxId: string): Promise<void> {
        this.presence.revokeContext(ctxId);
        await this.leases.revokeContext(ctxId);
        await this.actions.revokeContext(ctxId);
    }

    async revokeInstance(instance: string): Promise<void> {
        this.presence.revokeInstance(instance);
        await this.leases.revokeInstance(instance);
        await this.actions.revokeInstance(instance);
    }
}
