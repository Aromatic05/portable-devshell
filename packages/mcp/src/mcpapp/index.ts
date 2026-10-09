import type { ContextRecord, ContextTransport, ControlMcpContextMode, JsonValue, Endpoint } from '@portable-devshell/shared';
import { createMcpContextSelector } from '../protocol/Public.js';
import type { McpEndpointCallContext } from '../protocol/Api.js';
import { McpAppActionStore } from './ActionStore.js';
import { McpAppLeaseStore } from './app/Lease.js';
import { McpAppPresenceStore } from './app/Presence.js';
import { createMcpAppViewModel } from './ViewModel.js';
import { McpAppRoute } from './Route.js';
import type { HttpHost } from '../host/Http.js';

/** Owner for MCP App capabilities, durable action receipts, and presentation state. */
export class McpAppRuntime {
    readonly leases: McpAppLeaseStore;
    readonly actions: McpAppActionStore;
    readonly presence = new McpAppPresenceStore();
    readonly view?: ReturnType<typeof createMcpAppViewModel>;
    readonly #routes = new Map<HttpHost, McpAppRoute>();
    #initializePromise?: Promise<void>;

    constructor(options: { filePath?: string; endpoint?: Endpoint }) {
        this.leases = new McpAppLeaseStore({ filePath: options.filePath });
        this.actions = new McpAppActionStore({
            filePath: options.filePath === undefined ? undefined : `${options.filePath}.actions`,
        });
        this.view = options.endpoint === undefined ? undefined : createMcpAppViewModel(options.endpoint, this.actions);
    }

    /** One App Domain owns the Live Route for every attached HTTP host generation. */
    attachHost(host: HttpHost, contexts: Pick<ContextTransport, 'validateForInstance'>): McpAppRoute {
        let route = this.#routes.get(host);
        if (route === undefined) {
            route = new McpAppRoute(host, this, contexts);
            this.#routes.set(host, route);
        }
        return route;
    }

    detachHost(host: HttpHost): void {
        this.#routes.get(host)?.close();
        this.#routes.delete(host);
    }

    close(): void {
        for (const host of this.#routes.keys()) this.detachHost(host);
        this.presence.close();
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

    /** Reconcile durable credentials after a Control restart or Context ledger recovery. */
    async reconcileContexts(records: readonly ContextRecord[]): Promise<void> {
        await this.initialize();
        const retained = new Set(records.filter((record) => record.status !== "disabled")
            .map((record) => record.ctxId));
        const ids = new Set([...await this.leases.contextIds(), ...await this.actions.contextIds()]);
        for (const ctxId of ids) if (!retained.has(ctxId)) await this.revokeContext(ctxId);
    }

    /** Issues an Instance-bound capability for an authenticated MCP bootstrap result. */
    async bootstrap(options: {
        context: Pick<ContextTransport, 'resolve'>;
        contextMode?: ControlMcpContextMode;
        instance: string;
        publicBaseUrl?: string;
        request: McpEndpointCallContext;
        result: JsonValue;
    }): Promise<{ ctxId: string; token: string; liveBaseUrl?: string } | undefined> {
        const structured = typeof options.result === 'object' && options.result !== null && !Array.isArray(options.result)
            ? options.result : {};
        const ctxId = typeof structured.ctxId === 'string' ? structured.ctxId : undefined;
        const selector = createMcpContextSelector(options.contextMode ?? 'explicit');
        const externalBindings = selector.bindings(options.request);
        if (ctxId === undefined && externalBindings.length === 0) return undefined;
        const record = await options.context.resolve({
            ...(ctxId === undefined ? { externalBindings } : { ctxId }),
            instance: options.instance,
            principal: options.request.principal,
            touch: false,
        });
        if (record.status !== 'active' || !record.environments.some((entry) => entry.instance === options.instance))
            return undefined;
        const token = await this.leases.issue(options.instance, record.ctxId);
        this.presence.open(options.instance, record.ctxId);
        const base = options.publicBaseUrl;
        const liveBaseUrl = base === undefined ? undefined
            : base.replace(/\/+$/u, '') + '/api/live/' + encodeURIComponent(options.instance) + '/workspace';
        return {
            ctxId: record.ctxId,
            token,
            ...(liveBaseUrl === undefined ? {} : { liveBaseUrl }),
        };
    }

    async revokeContext(ctxId: string): Promise<void> {
        await this.initialize();
        this.presence.revokeContext(ctxId);
        await this.leases.revokeContext(ctxId);
        await this.actions.revokeContext(ctxId);
    }

    async revokeInstance(instance: string): Promise<void> {
        await this.initialize();
        this.presence.revokeInstance(instance);
        await this.leases.revokeInstance(instance);
        await this.actions.revokeInstance(instance);
    }
}
