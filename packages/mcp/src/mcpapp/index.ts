import type { ContextRecord, ContextTransport, ControlMcpContextMode, JsonValue, Endpoint } from '@portable-devshell/shared';
import { createMcpContextSelector } from '../protocol/Public.js';
import type { McpEndpointCallContext } from '../protocol/Api.js';
import { McpAppActionStore } from './ActionStore.js';
import { McpAppQuestionStore } from './Question.js';
import { McpAppLeaseStore } from './app/Lease.js';
import { McpAppPresenceStore } from './app/Presence.js';
import { createMcpAppViewModel } from './ViewModel.js';
import { McpAppRoute } from './Route.js';
import type { McpHttpRoute } from '../server/Api.js';

/** Owner for MCP App capabilities, durable action receipts, and presentation state. */
export class McpAppRuntime {
    readonly leases: McpAppLeaseStore;
    readonly actions: McpAppActionStore;
    readonly questions: McpAppQuestionStore;
    readonly presence = new McpAppPresenceStore();
    readonly view?: ReturnType<typeof createMcpAppViewModel>;
    readonly #routes = new Map<McpHttpRoute, McpAppRoute>();
    #initializePromise?: Promise<void>;
    readonly #pendingContextCleanup = new Set<string>();
    #contextCleanup?: Promise<void>;
    #cleanupRetry?: ReturnType<typeof setTimeout>;
    #cleanupRetryCount = 0;
    #closed = false;

    constructor(options: { filePath?: string; endpoint?: Endpoint }) {
        this.leases = new McpAppLeaseStore({ filePath: options.filePath });
        this.actions = new McpAppActionStore({
            filePath: options.filePath === undefined ? undefined : `${options.filePath}.actions`,
        });
        this.questions = new McpAppQuestionStore(options.filePath === undefined ? undefined : `${options.filePath}.questions`);
        this.view = options.endpoint === undefined ? undefined : createMcpAppViewModel(options.endpoint, this.actions, this.questions);
    }

    /** One App Domain owns the Live Route for every attached HTTP host generation. */
    attachHost(host: McpHttpRoute, contexts: Pick<ContextTransport, 'validateForInstance'>, publicBaseUrl?: string): McpAppRoute {
        let route = this.#routes.get(host);
        if (route === undefined) {
            route = new McpAppRoute(host, this, contexts, publicBaseUrl);
            this.#routes.set(host, route);
        }
        return route;
    }

    detachHost(host: McpHttpRoute): void {
        this.#routes.get(host)?.close();
        this.#routes.delete(host);
    }

    async close(): Promise<void> {
        this.#closed = true;
        if (this.#cleanupRetry !== undefined) clearTimeout(this.#cleanupRetry);
        const failures: unknown[] = [];
        for (const host of [...this.#routes.keys()]) {
            try { this.detachHost(host); } catch (error) { failures.push(error); }
        }
        this.presence.close();
        await this.flushContextCleanup().catch((error) => failures.push(error));
        if (failures.length > 0) throw new AggregateError(failures, 'MCP App shutdown cleanup failed');
    }

    /** Control reports terminal Contexts; only App owns durable cleanup and retry. */
    onContextTerminated(ctxId: string): void {
        for (const route of this.#routes.values()) {
            try { route.revokeContext(ctxId); }
            catch (error) { console.warn('MCP App Live Context revocation failed:', error); }
        }
        this.presence.revokeContext(ctxId);
        this.#pendingContextCleanup.add(ctxId);
        this.#scheduleContextCleanup();
    }

    async flushContextCleanup(): Promise<void> {
        if (this.#cleanupRetry !== undefined) clearTimeout(this.#cleanupRetry);
        this.#cleanupRetry = undefined;
        await this.#contextCleanup?.catch(() => undefined);
        if (this.#pendingContextCleanup.size === 0) return;
        try { await this.#drainContextCleanup(); }
        catch (error) { this.#scheduleCleanupRetry(); throw error; }
    }

    #scheduleContextCleanup(): void {
        if (this.#contextCleanup !== undefined || this.#closed) return;
        if (this.#cleanupRetry !== undefined) clearTimeout(this.#cleanupRetry);
        this.#cleanupRetry = undefined;
        const pending = this.#drainContextCleanup();
        this.#contextCleanup = pending;
        void pending.catch((error: unknown) => {
            console.warn('MCP App Context cleanup failed; retry scheduled:', error);
        }).finally(() => {
            if (this.#contextCleanup === pending) this.#contextCleanup = undefined;
            if (this.#pendingContextCleanup.size > 0) this.#scheduleCleanupRetry();
        });
    }

    async #drainContextCleanup(): Promise<void> {
        await this.initialize();
        const failures: unknown[] = [];
        for (const ctxId of [...this.#pendingContextCleanup]) {
            try {
                await this.revokeContext(ctxId);
                this.#pendingContextCleanup.delete(ctxId);
            } catch (error) { failures.push(error); }
        }
        if (failures.length > 0) throw new AggregateError(failures, 'MCP App Context cleanup failed');
        this.#cleanupRetryCount = 0;
    }

    #scheduleCleanupRetry(): void {
        if (this.#closed || this.#cleanupRetry !== undefined || this.#pendingContextCleanup.size === 0) return;
        const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(this.#cleanupRetryCount++, 5));
        this.#cleanupRetry = setTimeout(() => {
            this.#cleanupRetry = undefined;
            this.#scheduleContextCleanup();
        }, delayMs);
        this.#cleanupRetry.unref();
    }

    async initialize(): Promise<void> {
        if (this.#initializePromise !== undefined) return await this.#initializePromise;
        const pending = Promise.all([this.leases.initialize(), this.actions.initialize(), this.questions.initialize()]).then(() => undefined);
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
        const ids = new Set([...await this.leases.contextIds(), ...await this.actions.contextIds(), ...this.questions.contextIds()]);
        for (const ctxId of ids) if (!retained.has(ctxId)) {
            try {
                await this.revokeContext(ctxId);
                this.#pendingContextCleanup.delete(ctxId);
            } catch (error) {
                this.#pendingContextCleanup.add(ctxId);
                console.warn("MCP App Context reconciliation deferred:", error);
            }
        }
        if (this.#pendingContextCleanup.size > 0) this.#scheduleCleanupRetry();
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
        await this.questions.revokeContext(ctxId);
    }

    async revokeInstance(instance: string): Promise<void> {
        await this.initialize();
        this.presence.revokeInstance(instance);
        await this.leases.revokeInstance(instance);
        await this.actions.revokeInstance(instance);
        await this.questions.revokeInstance(instance);
    }
}
