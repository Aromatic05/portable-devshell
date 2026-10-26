// Stateful tool-call ledger projection. This view model owns the per-instance
// tool-call list, its subscription status, and its gap recovery policy. It does
// not own tool execution session state; `call`/`callStreaming` stay on the
// transport and are exposed here only as thin delegates.
//
// Cursor safety: `ToolTransport.listCalls` returns a bare record array with no
// `lastSeq`, so the ledger snapshot alone cannot produce a race-safe
// subscription cursor. The view model therefore requires an authoritative
// cursor provider supplied by composition (typically the Process snapshot's
// `lastSeq`). The cursor is sampled *before* the ledger read so the later read
// is guaranteed to cover every event up to the cursor; subscribing from
// cursor + 1 then cannot open a gap. Events are filtered to `toolCall.*` and
// coalesced into an authoritative ledger re-read. Gap recovery samples a fresh
// cursor first, re-reads the ledger, and resumes from cursor + 1.

import type { JsonValue } from "../../types/Json.js";
import {
    InstanceEventSubscription,
    type InstanceEventSubscriptionStatus,
} from "../../client/Stream.js";
import {
    isToolCallEvent,
    type ToolEvent,
    type ToolCallQuery,
    type ToolCallRecord,
} from "./Model.js";
import type { ToolCallOptions, ToolTransport } from "./Transport.js";

/** Base ledger read: newest 200 records, bounded to ~512 KiB. */
const TOOL_CALL_LIST_LIMIT = 200;
const TOOL_CALL_LIST_MAX_BYTES = 512 * 1024;
/** Detail reads carry full input/output, so the byte budget is much larger. */
const TOOL_CALL_DETAIL_MAX_BYTES = 8 * 1024 * 1024;

const DEFAULT_REFRESH_DELAY_MS = 100;

interface ToolCallInstanceState {
    calls: ToolCallRecord[];
    failure?: Error;
    /** Cursor is in audit insertion order, not the UI's startedAt order. */
    historyBefore?: string;
    historyExhausted?: boolean;
    historyLoaded?: boolean;
    /** Last observed event sequence; informational, the engine owns the cursor. */
    lastSeq: number;
    status: InstanceEventSubscriptionStatus;
}

export interface ToolCallContextHistoryState {
    calls: ToolCallRecord[];
    ctxId: string;
    failure?: Error;
    /** Audit insertion-order cursor; independent of the instance preview. */
    historyBefore?: string;
    historyExhausted?: boolean;
    historyLoaded?: boolean;
    instance: string;
    loading: boolean;
}

export interface ToolCallViewModelState {
    context?: ToolCallContextHistoryState;
    instances: Record<string, ToolCallInstanceState>;
}

interface ToolCallViewModelOptions {
    /**
     * Authoritative instance event sequence at call time. Required because
     * `ToolTransport.listCalls` has no `lastSeq`; composition supplies it from
     * the Process snapshot.
     */
    cursor(instance: string): Promise<number>;
    onEvent?(event: ToolEvent): void;
    refreshDelayMs?: number;
    retryBaseMs?: number;
    retryMaxMs?: number;
    transport(instance: string): ToolTransport;
}

export class ToolCallViewModel {
    readonly #contextHistoryLoads = new Map<string, Promise<number>>();
    readonly #cursor: (instance: string) => Promise<number>;
    readonly #listeners = new Set<() => void>();
    readonly #historyLoads = new Map<string, Promise<number>>();
    readonly #onEvent?: (event: ToolEvent) => void;
    readonly #queries = new Map<string, ToolCallQuery | undefined>();
    readonly #refreshDelayMs: number;
    readonly #refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
    readonly #retryBaseMs: number;
    readonly #retryMaxMs: number;
    readonly #subscriptions = new Map<
        string,
        InstanceEventSubscription<ToolEvent>
    >();
    readonly #transport: (instance: string) => ToolTransport;
    readonly #versions = new Map<string, number>();
    #contextSelection = 0;
    #epoch = 0;
    #published: ToolCallViewModelState = emptyState();
    #state: ToolCallViewModelState = emptyState();

    constructor(options: ToolCallViewModelOptions) {
        this.#cursor = options.cursor;
        this.#onEvent = options.onEvent;
        this.#refreshDelayMs =
            options.refreshDelayMs ?? DEFAULT_REFRESH_DELAY_MS;
        this.#retryBaseMs = options.retryBaseMs ?? 500;
        this.#retryMaxMs = options.retryMaxMs ?? 15_000;
        this.#transport = options.transport;
    }

    get state(): Readonly<ToolCallViewModelState> {
        return this.#published;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /**
     * Materializes one instance: samples the authoritative cursor, reads the
     * ledger, then lazily starts the instance's event subscription. Calling it
     * again for the same instance re-reads the ledger without restarting the
     * subscription.
     */
    async load(instance: string, query?: ToolCallQuery): Promise<void> {
        if (this.#queries.has(instance) &&
            JSON.stringify(this.#queries.get(instance)) !== JSON.stringify(query)) {
            // A changed query must not retain pages from another Context,
            // source, or tool filter.
            this.#updateInstance(instance, (state) => ({
                ...state,
                calls: [],
                historyBefore: undefined,
                historyExhausted: undefined,
                historyLoaded: false,
            }));
            this.#emit();
        }
        this.#queries.set(instance, query);
        const epoch = this.#epoch;
        let cursor: number;
        try {
            cursor = await this.#cursor(instance);
        } catch (error) {
            if (!this.#current(epoch)) return;
            this.#setFailure(instance, error);
            this.#emit();
            return;
        }
        if (!this.#current(epoch)) return;
        await this.#refreshInstance(instance, epoch);
        if (!this.#current(epoch)) return;
        this.#ensureSubscription(instance, cursor + 1);
    }

    /** Re-reads the authoritative ledger for one materialized instance. */
    async refresh(instance: string): Promise<void> {
        await this.#refreshInstance(instance, this.#epoch);
    }

    /** Reads older ledger pages while retaining the live projection. */
    async loadOlder(instance: string): Promise<number> {
        const pending = this.#historyLoads.get(instance);
        if (pending !== undefined) return await pending;
        const request = this.#loadOlder(instance);
        this.#historyLoads.set(instance, request);
        try {
            return await request;
        } finally {
            if (this.#historyLoads.get(instance) === request)
                this.#historyLoads.delete(instance);
        }
    }

    /** Query a Context before pagination; keep it separate from the instance preview. */
    async loadContext(instance: string, ctxId: string): Promise<void> {
        const context = this.#state.context;
        if (context?.instance !== instance || context.ctxId !== ctxId) {
            if (context !== undefined)
                this.#contextHistoryLoads.delete(JSON.stringify([context.instance, context.ctxId]));
            this.#contextSelection += 1;
            this.#nextVersion("tool:context");
            this.#state.context = { calls: [], ctxId, instance, loading: true };
            this.#emit();
        }
        await this.#refreshContext(instance, ctxId);
    }

    clearContext(instance: string, ctxId: string): void {
        if (this.#state.context?.instance !== instance ||
            this.#state.context.ctxId !== ctxId) return;
        this.#contextSelection += 1;
        this.#nextVersion("tool:context");
        this.#contextHistoryLoads.delete(JSON.stringify([instance, ctxId]));
        this.#state.context = undefined;
        this.#emit();
    }

    async loadOlderContext(instance: string, ctxId: string): Promise<number> {
        const key = JSON.stringify([instance, ctxId]);
        const pending = this.#contextHistoryLoads.get(key);
        if (pending !== undefined) return await pending;
        const request = this.#loadOlderContext(instance, ctxId);
        this.#contextHistoryLoads.set(key, request);
        try {
            return await request;
        } finally {
            if (this.#contextHistoryLoads.get(key) === request)
                this.#contextHistoryLoads.delete(key);
        }
    }

    async #loadOlderContext(instance: string, ctxId: string): Promise<number> {
        const initial = this.#state.context;
        if (initial?.instance !== instance || initial.ctxId !== ctxId ||
            initial.historyBefore === undefined || initial.historyExhausted)
            return 0;
        const before = initial.historyBefore;
        const epoch = this.#epoch;
        const selection = this.#contextSelection;
        try {
            const calls = await this.#transport(instance).listCalls(listQuery({ ctxId, before }));
            const current = this.#state.context;
            if (!this.#current(epoch) || selection !== this.#contextSelection ||
                current?.instance !== instance ||
                current.ctxId !== ctxId || current.historyBefore !== before)
                return 0;
            this.#state.context = {
                ...current,
                calls: orderCalls(mergeCalls(current.calls, calls)),
                failure: undefined,
                historyBefore: calls[0]?.callId ?? before,
                historyExhausted: calls.length === 0,
                historyLoaded: true,
            };
            this.#emit();
            return calls.length;
        } catch (error) {
            const current = this.#state.context;
            if (this.#current(epoch) && selection === this.#contextSelection &&
                current?.instance === instance &&
                current.ctxId === ctxId && current.historyBefore === before) {
                this.#state.context = { ...current, failure: toError(error) };
                this.#emit();
            }
            throw error;
        }
    }

    async #loadOlder(instance: string): Promise<number> {
        const initial = this.#state.instances[instance];
        const before = initial?.historyBefore;
        if (before === undefined || initial?.historyExhausted) return 0;
        const epoch = this.#epoch;
        const query = this.#queries.get(instance);
        const calls = await this.#transport(instance).listCalls(
            listQuery({ ...query, before }),
        );
        if (!this.#current(epoch) || this.#queries.get(instance) !== query ||
            this.#state.instances[instance]?.historyBefore !== before)
            return 0;
        this.#updateInstance(instance, (state) => ({
            ...state,
            calls: orderCalls(mergeCalls(state.calls, calls)),
            historyBefore: calls[0]?.callId ?? before,
            historyExhausted: calls.length === 0,
            historyLoaded: true,
        }));
        this.#emit();
        return calls.length;
    }

    /**
     * Reads full input/output for one or more calls without touching the base
     * ledger. Accepts a call id, a list of call ids, or a record to read.
     */
    async readDetail(
        instance: string,
        selector: string | readonly string[] | Pick<ToolCallRecord, "callId">,
    ): Promise<ToolCallRecord[]> {
        const callIds = detailCallIds(selector);
        if (callIds.length === 0) return [];
        return this.#transport(instance).listCalls({
            callIds,
            includeInput: true,
            includeOutput: true,
            limit: callIds.length,
            maxBytes: TOOL_CALL_DETAIL_MAX_BYTES,
        });
    }

    call(
        instance: string,
        toolName: string,
        input: JsonValue,
        workspace: string,
    ): Promise<JsonValue> {
        return this.#transport(instance).call(toolName, input, workspace);
    }

    callStreaming(
        instance: string,
        toolName: string,
        input: JsonValue,
        workspace: string,
        options?: ToolCallOptions,
    ): Promise<JsonValue> {
        return this.#transport(instance).callStreaming(
            toolName,
            input,
            workspace,
            options,
        );
    }

    /** Stops one instance's subscription, or every subscription when omitted. */
    stop(instance?: string): void {
        if (instance === undefined) {
            for (const timer of this.#refreshTimers.values())
                clearTimeout(timer);
            this.#refreshTimers.clear();
            this.#closeSubscriptions();
            return;
        }
        const timer = this.#refreshTimers.get(instance);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.#refreshTimers.delete(instance);
        }
        this.#subscriptions.get(instance)?.stop();
        this.#subscriptions.delete(instance);
    }

    /** Stops and forgets one materialized instance. */
    release(instance: string): void {
        this.stop(instance);
        this.#queries.delete(instance);
        this.#versions.delete(instanceKey(instance));
        const hadContext = this.#state.context?.instance === instance;
        if (hadContext) {
            this.#contextSelection += 1;
            this.#nextVersion("tool:context");
            this.#contextHistoryLoads.delete(JSON.stringify([instance, this.#state.context!.ctxId]));
            this.#state.context = undefined;
        }
        if (!(instance in this.#state.instances)) {
            if (hadContext) this.#emit();
            return;
        }
        const instances = { ...this.#state.instances };
        delete instances[instance];
        this.#state = { ...this.#state, instances };
        this.#emit();
    }

    close(): void {
        this.#epoch += 1;
        for (const timer of this.#refreshTimers.values()) clearTimeout(timer);
        this.#refreshTimers.clear();
        this.#versions.clear();
        this.#queries.clear();
        this.#historyLoads.clear();
        this.#contextHistoryLoads.clear();
        this.#closeSubscriptions();
        this.#listeners.clear();
        this.#state = emptyState();
        this.#published = this.#state;
    }

    /** Returns true when the authoritative ledger was applied. */
    async #refreshInstance(instance: string, epoch: number): Promise<boolean> {
        const key = instanceKey(instance);
        const version = this.#nextVersion(key);
        const query = listQuery(this.#queries.get(instance));
        try {
            const state = this.#state.instances[instance];
            const calls = await this.#readRefresh(instance, query, state?.historyLoaded ? state.calls : []);
            if (!this.#valid(key, version, epoch)) return false;
            this.#updateInstance(instance, (state) => ({
                ...state,
                calls: orderCalls(state.historyLoaded ? mergeCalls(state.calls, calls) : calls),
                failure: undefined,
                historyBefore: state.historyLoaded ? state.historyBefore : calls[0]?.callId,
                historyExhausted: state.historyLoaded ? state.historyExhausted : calls.length === 0,
            }));
            this.#emit();
            const context = this.#state.context;
            if (context?.instance === instance)
                void this.#refreshContext(instance, context.ctxId);
            return true;
        } catch (error) {
            if (!this.#valid(key, version, epoch)) return false;
            this.#setFailure(instance, error);
            this.#emit();
            return false;
        }
    }

    async #refreshContext(instance: string, ctxId: string): Promise<void> {
        const context = this.#state.context;
        if (context?.instance !== instance || context.ctxId !== ctxId) return;
        const key = "tool:context";
        const version = this.#nextVersion(key);
        const epoch = this.#epoch;
        this.#state.context = { ...context, loading: true };
        this.#emit();
        try {
            const calls = await this.#readRefresh(instance, listQuery({ ctxId }), context.historyLoaded ? context.calls : []);
            const current = this.#state.context;
            if (!this.#valid(key, version, epoch) || current?.instance !== instance ||
                current.ctxId !== ctxId) return;
            this.#state.context = {
                ...current,
                calls: orderCalls(current.historyLoaded ? mergeCalls(current.calls, calls) : calls),
                failure: undefined,
                historyBefore: current.historyLoaded ? current.historyBefore : calls[0]?.callId,
                historyExhausted: current.historyLoaded ? current.historyExhausted : calls.length === 0,
                loading: false,
            };
            this.#emit();
        } catch (error) {
            const current = this.#state.context;
            if (!this.#valid(key, version, epoch) || current?.instance !== instance ||
                current.ctxId !== ctxId) return;
            this.#state.context = { ...current, failure: toError(error), loading: false };
            this.#emit();
        }
    }

    async #readRefresh(instance: string, query: ToolCallQuery, existing: ToolCallRecord[]): Promise<ToolCallRecord[]> {
        const known = new Set(existing.map((call) => call.callId));
        const calls = await this.#transport(instance).listCalls(query);
        let page = calls;
        // Page backwards until the new window meets the retained history.
        while (known.size > 0 && page.length > 0 && !page.some((call) => known.has(call.callId))) {
            page = await this.#transport(instance).listCalls({ ...query, before: page[0]!.callId });
            calls.unshift(...page);
        }
        return calls;
    }

    #ensureSubscription(instance: string, fromSeq: number): void {
        if (this.#subscriptions.has(instance)) return;
        const epoch = this.#epoch;
        const subscription = new InstanceEventSubscription<ToolEvent>(fromSeq, {
            onEvent: (event) => {
                if (this.#current(epoch)) this.#applyEvent(event);
            },
            onGap: () => this.#recover(instance, epoch),
            onStatusChange: (status) => {
                if (!this.#current(epoch)) return;
                this.#updateInstance(instance, (state) => ({
                    ...state,
                    status,
                }));
                this.#emit();
            },
            open: (cursor) => this.#transport(instance).subscribe(cursor),
            retryBaseMs: this.#retryBaseMs,
            retryMaxMs: this.#retryMaxMs,
        });
        this.#subscriptions.set(instance, subscription);
        subscription.start();
    }

    #applyEvent(event: ToolEvent): void {
        if (!isToolCallEvent(event.type)) return;
        const instance = event.instanceName;
        this.#updateInstance(instance, (state) => ({
            ...state,
            lastSeq: Math.max(state.lastSeq, event.seq),
        }));
        this.#scheduleRefresh(instance, this.#epoch);
        this.#onEvent?.(event);
        this.#emit();
    }

    async #recover(
        instance: string,
        epoch: number,
    ): Promise<number | undefined> {
        try {
            // Sample the cursor before the ledger read so the read covers it.
            const cursor = await this.#cursor(instance);
            if (!this.#current(epoch)) return undefined;
            const applied = await this.#refreshInstance(instance, epoch);
            if (!applied || !this.#current(epoch)) return undefined;
            return cursor + 1;
        } catch {
            return undefined;
        }
    }

    #scheduleRefresh(instance: string, epoch: number): void {
        if (this.#refreshTimers.has(instance)) return;
        const timer = setTimeout(() => {
            this.#refreshTimers.delete(instance);
            if (this.#current(epoch))
                void this.#refreshInstance(instance, epoch);
        }, this.#refreshDelayMs);
        this.#refreshTimers.set(instance, timer);
    }

    #closeSubscriptions(): void {
        for (const subscription of this.#subscriptions.values())
            subscription.stop();
        this.#subscriptions.clear();
    }

    #updateInstance(
        instance: string,
        update: (state: ToolCallInstanceState) => ToolCallInstanceState,
    ): void {
        this.#state.instances = {
            ...this.#state.instances,
            [instance]: update(
                this.#state.instances[instance] ?? emptyInstanceState(),
            ),
        };
    }

    #setFailure(instance: string, error: unknown): void {
        this.#updateInstance(instance, (state) => ({
            ...state,
            failure: toError(error),
        }));
    }

    #nextVersion(key: string): number {
        const version = (this.#versions.get(key) ?? 0) + 1;
        this.#versions.set(key, version);
        return version;
    }

    #valid(key: string, version: number, epoch: number): boolean {
        return this.#current(epoch) && this.#versions.get(key) === version;
    }

    #current(epoch: number): boolean {
        return this.#epoch === epoch;
    }

    #emit(): void {
        this.#published = this.#state;
        this.#state = {
            ...this.#published,
            instances: { ...this.#published.instances },
        };
        for (const listener of this.#listeners) listener();
    }
}

function emptyState(): ToolCallViewModelState {
    return { instances: {} };
}

function emptyInstanceState(): ToolCallInstanceState {
    return { calls: [], lastSeq: 0, status: "stopped" };
}

function instanceKey(instance: string): string {
    return `tool:${instance}`;
}

/**
 * Base list query. Heavy `input`/`output` are always excluded so the ledger
 * stays small; a caller-supplied query can only filter and bound more tightly.
 */
function listQuery(query: ToolCallQuery | undefined): ToolCallQuery {
    return {
        ...query,
        includeInput: false,
        includeOutput: false,
        limit: query?.limit ?? TOOL_CALL_LIST_LIMIT,
        maxBytes: query?.maxBytes ?? TOOL_CALL_LIST_MAX_BYTES,
    };
}

function orderCalls(calls: readonly ToolCallRecord[]): ToolCallRecord[] {
    return [...calls].sort(
        (left, right) =>
            right.startedAt.localeCompare(left.startedAt) ||
            left.callId.localeCompare(right.callId),
    );
}

function mergeCalls(
    previous: readonly ToolCallRecord[],
    current: readonly ToolCallRecord[],
): ToolCallRecord[] {
    const merged = new Map(previous.map((call) => [call.callId, call]));
    for (const call of current) merged.set(call.callId, call);
    return [...merged.values()];
}

function detailCallIds(
    selector: string | readonly string[] | Pick<ToolCallRecord, "callId">,
): string[] {
    const values: readonly string[] =
        typeof selector === "string"
            ? [selector]
            : "callId" in selector
              ? [selector.callId]
              : selector;
    return [...new Set(values.filter((callId) => callId.length > 0))];
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
