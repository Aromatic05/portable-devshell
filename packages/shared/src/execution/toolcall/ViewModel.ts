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
    /** Last observed event sequence; informational, the engine owns the cursor. */
    lastSeq: number;
    status: InstanceEventSubscriptionStatus;
}

export interface ToolCallViewModelState {
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
    readonly #cursor: (instance: string) => Promise<number>;
    readonly #listeners = new Set<() => void>();
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
        if (!(instance in this.#state.instances)) return;
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
            const calls = await this.#transport(instance).listCalls(query);
            if (!this.#valid(key, version, epoch)) return false;
            this.#updateInstance(instance, (state) => ({
                ...state,
                calls: orderCalls(calls),
                failure: undefined,
            }));
            this.#emit();
            return true;
        } catch (error) {
            if (!this.#valid(key, version, epoch)) return false;
            this.#setFailure(instance, error);
            this.#emit();
            return false;
        }
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
