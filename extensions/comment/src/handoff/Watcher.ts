import { readStreamGap } from "@portable-devshell/shared";
import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type {
    ExtensionContextObserveCapability,
    ExtensionContextRecord,
} from "@portable-devshell/extension/context";
import type {
    ExtensionInstanceEvent,
    ExtensionInstanceObserveCapability,
} from "@portable-devshell/extension/instance";

const TERMINAL_CONTROL_RELEASED_EVENT = "terminal.controlReleased";
const RECONNECT_DELAY_MS = 2_000;

export interface TerminalHandoffWatcherOptions {
    readonly contextObserve?: ExtensionContextObserveCapability;
    readonly instanceObserve: ExtensionInstanceObserveCapability;
    readonly onError?: (instance: string, error: unknown) => void;
    readonly queue: (
        instance: string,
        id: string,
        text: string,
        selectRecipient: () => Promise<string | undefined>,
    ) => Promise<void>;
    readonly readCursor: (instance: string) => Promise<number | undefined>;
    readonly writeCursor: (instance: string, seq: number) => Promise<void>;
    readonly reconnectDelayMs?: number;
}

interface InstanceWatchState {
    readonly controller: AbortController;
    readonly running: Promise<void>;
    lastSeq?: number;
    resetSeq?: number;
    timer?: ReturnType<typeof setTimeout>;
}

/**
 * Watches `terminal.controlReleased` Instance events and queues a concise
 * handoff Comment to one active Context sharing that Instance/workspace so
 * the same release does not ask multiple models to resume the terminal.
 */
export class TerminalHandoffWatcher {
    readonly #options: TerminalHandoffWatcherOptions;
    readonly #reconnectDelayMs: number;
    readonly #watches = new Map<string, InstanceWatchState>();
    readonly #retiring = new Map<string, Promise<void>>();
    #closed = false;

    constructor(options: TerminalHandoffWatcherOptions) {
        this.#options = options;
        this.#reconnectDelayMs = options.reconnectDelayMs ?? RECONNECT_DELAY_MS;
    }

    sync(instances: readonly { readonly enabled: boolean; readonly name: string }[]): void {
        if (this.#closed || this.#options.contextObserve === undefined) return;
        const active = new Set<string>();
        for (const instance of instances) {
            if (!instance.enabled) continue;
            active.add(instance.name);
            if (!this.#watches.has(instance.name)) {
                this.#startWatch(instance.name);
            }
        }
        for (const name of [...this.#watches.keys()]) {
            if (!active.has(name)) void this.retireInstance(name);
        }
    }

    retireInstance(instance: string): Promise<void> {
        const state = this.#watches.get(instance);
        if (state === undefined) return this.#retiring.get(instance) ?? Promise.resolve();
        this.#watches.delete(instance);
        state.controller.abort();
        const retired = state.running.finally(() => {
            if (this.#retiring.get(instance) === retired) this.#retiring.delete(instance);
        });
        this.#retiring.set(instance, retired);
        return retired;
    }

    async close(): Promise<void> {
        this.#closed = true;
        for (const name of this.#watches.keys()) this.retireInstance(name);
        await Promise.all(this.#retiring.values());
    }

    #startWatch(instance: string): void {
        const controller = new AbortController();
        // Do not load a checkpoint while an earlier watch can still write it.
        const previous = this.#retiring.get(instance) ?? Promise.resolve();
        const state: InstanceWatchState = {
            controller,
            running: previous.then(() => this.#runWatch(instance, state)),
        };
        this.#watches.set(instance, state);
    }

    async #runWatch(instance: string, state: InstanceWatchState): Promise<void> {
        const signal = state.controller.signal;
        let initialCursor: number | undefined;
        const acknowledge = async (seq: number): Promise<void> => {
            signal.throwIfAborted();
            await this.#options.writeCursor(instance, seq);
            state.lastSeq = seq;
            state.resetSeq = undefined;
        };
        while (!signal.aborted) {
            try {
                if (state.resetSeq !== undefined) await acknowledge(state.resetSeq);
                if (state.lastSeq === undefined) {
                    state.lastSeq = await this.#options.readCursor(instance);
                    if (state.lastSeq === undefined) {
                        signal.throwIfAborted();
                        initialCursor ??= (await this.#options.instanceObserve.snapshot(instance)).lastSeq;
                        await acknowledge(initialCursor);
                    }
                }
                signal.throwIfAborted();
                await this.#watch(instance, state, acknowledge);
            } catch (error) {
                if (signal.aborted) return;
                this.#options.onError?.(instance, error);
            }
            if (!signal.aborted) await this.#delay(state);
        }
    }

    async #watch(
        instance: string,
        state: InstanceWatchState,
        acknowledge: (seq: number) => Promise<void>,
    ): Promise<void> {
        const fromSeq = state.lastSeq! + 1;
        const attempt = new AbortController();
        const signal = AbortSignal.any([state.controller.signal, attempt.signal]);
        let accepting = true;
        let tail = Promise.resolve();
        const deliver = (work: () => Promise<void>): Promise<void> => {
            if (!accepting) return Promise.resolve();
            const pending = tail.then(async () => {
                if (!signal.aborted) await work();
            });
            tail = pending.catch((error: unknown) => { attempt.abort(error); });
            return pending;
        };
        let failure: { error: unknown } | undefined;
        try {
            await this.#options.instanceObserve.watchEvents(instance, {
                eventTypes: [TERMINAL_CONTROL_RELEASED_EVENT],
                fromSeq,
                onEvent: (event) => deliver(async () => {
                    if (event.seq <= state.lastSeq!) return;
                    await this.#handleEvent(instance, event, signal);
                    await acknowledge(event.seq);
                }),
                onGap: (gap) => deliver(async () => {
                    if (!validGap(gap)) throw new Error("Invalid terminal handoff stream gap");
                    if (gap.lastSeq < state.lastSeq!) state.resetSeq = gap.nextSeq - 1;
                    if (state.resetSeq !== undefined || gap.nextSeq > state.lastSeq! + 1) {
                        // Only the prefix before the oldest retained event is lost.
                        await acknowledge(gap.nextSeq - 1);
                    }
                }),
                signal,
            });
        } catch (error) {
            failure = { error };
        } finally {
            accepting = false;
            await tail;
        }
        if (attempt.signal.aborted) throw attempt.signal.reason;
        if (signal.aborted || failure === undefined) return;
        const gap = readStreamGap(failure.error);
        if (gap === undefined || gap.fromSeq !== fromSeq || state.lastSeq !== fromSeq - 1 ||
            !validGap(gap) || (fromSeq >= gap.nextSeq && fromSeq <= gap.lastSeq + 1)) throw failure.error;
        // Initial subscription failed. Reconnect at the oldest retained
        // event, also when the source reports that the old cursor is ahead.
        // A failed reset write must not reopen the new source at the old
        // cursor: by the next retry its high water may have caught up.
        if (fromSeq > gap.lastSeq + 1) state.resetSeq = gap.nextSeq - 1;
        await acknowledge(gap.nextSeq - 1);
    }

    async #handleEvent(
        instance: string,
        event: ExtensionInstanceEvent,
        signal: AbortSignal,
    ): Promise<void> {
        const observe = this.#options.contextObserve;
        if (event.type !== TERMINAL_CONTROL_RELEASED_EVENT || observe === undefined) return;
        const payload = parseReleasePayload(event.data);
        if (payload === undefined) return;
        const data = event.data as Record<string, ExtensionJsonValue>;
        // seq is scoped to the event log; include release identity so a
        // replacement log reusing a sequence does not reuse the old receipt.
        const id = JSON.stringify([event.seq, event.at, payload.terminalId, data.generation, data.releasedAt]);
        const targetWorkspace = normalizeWorkspace(payload.workspace);
        await this.#options.queue(instance, id, formatHandoffComment(payload), async () => {
            signal.throwIfAborted();
            const contexts = await observe.list({ instance, status: "active" });
            signal.throwIfAborted();
            return selectHandoffRecipient(contexts.filter((ctx) =>
                ctx.environments.some(
                    (env) => env.instance === instance && normalizeWorkspace(env.workspace) === targetWorkspace,
                ),
            ))?.ctxId;
        });
    }

    #delay(state: InstanceWatchState): Promise<void> {
        return new Promise((resolve) => {
            const onAbort = () => {
                if (state.timer !== undefined) {
                    clearTimeout(state.timer);
                    state.timer = undefined;
                }
                resolve();
            };
            if (state.controller.signal.aborted) {
                resolve();
                return;
            }
            state.controller.signal.addEventListener("abort", onAbort, {
                once: true,
            });
            state.timer = setTimeout(() => {
                state.timer = undefined;
                state.controller.signal.removeEventListener("abort", onAbort);
                resolve();
            }, this.#reconnectDelayMs);
            state.timer.unref?.();
        });
    }
}

interface ControlReleasedPayload {
    readonly cols?: number;
    readonly cwd?: string;
    readonly name?: string;
    readonly rows?: number;
    readonly terminalId: string;
    readonly workspace?: string;
}

function parseReleasePayload(
    data: ExtensionJsonValue | undefined,
): ControlReleasedPayload | undefined {
    if (typeof data !== "object" || data === null || Array.isArray(data))
        return undefined;
    if (typeof data.terminalId !== "string" || data.terminalId.length === 0)
        return undefined;
    return {
        ...(typeof data.cols === "number" ? { cols: data.cols } : {}),
        ...(typeof data.cwd === "string" && data.cwd.length > 0
            ? { cwd: data.cwd }
            : {}),
        ...(typeof data.name === "string" && data.name.length > 0
            ? { name: data.name }
            : {}),
        ...(typeof data.rows === "number" ? { rows: data.rows } : {}),
        terminalId: data.terminalId,
        ...(typeof data.workspace === "string" && data.workspace.length > 0
            ? { workspace: data.workspace }
            : {}),
    };
}

function selectHandoffRecipient(
    contexts: readonly ExtensionContextRecord[],
): ExtensionContextRecord | undefined {
    return [...contexts].sort((left, right) =>
        right.lastAccessedAt.localeCompare(left.lastAccessedAt) ||
        right.createdAt.localeCompare(left.createdAt) ||
        left.ctxId.localeCompare(right.ctxId),
    )[0];
}

function formatHandoffComment(payload: ControlReleasedPayload): string {
    const label =
        payload.name !== undefined
            ? `"${payload.name}" (${payload.terminalId})`
            : payload.terminalId;
    const details: string[] = [];
    if (payload.cols !== undefined && payload.rows !== undefined) {
        details.push(`${payload.cols}x${payload.rows}`);
    }
    if (payload.cwd !== undefined) {
        details.push(`cwd: ${payload.cwd}`);
    }
    const suffix = details.length > 0 ? ` [${details.join(", ")}]` : "";
    return `[Terminal handoff] Human released control of terminal ${label}${suffix}. If this terminal belongs to your current task, inspect its screen with task_inspect before resuming. Only send input if your task needs it; when using task_input, omit any pre-handoff cursor to anchor at the latest output.`;
}

function normalizeWorkspace(
    workspace: string | undefined,
): string | undefined {
    if (workspace === undefined || workspace.length === 0) return undefined;
    if (workspace === "/") return "/";
    const trimmed = workspace.replace(/\/+$/u, "");
    return trimmed.length === 0 ? "/" : trimmed;
}

function validGap(gap: { lastSeq: number; nextSeq: number }): boolean {
    return Number.isSafeInteger(gap.lastSeq) && Number.isSafeInteger(gap.nextSeq) &&
        gap.nextSeq >= 1 && gap.nextSeq <= gap.lastSeq + 1;
}
