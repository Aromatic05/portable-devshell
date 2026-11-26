import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type { ExtensionContextObserveCapability } from "@portable-devshell/extension/context";
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
        ctxId: string,
        text: string,
    ) => Promise<void>;
    readonly reconnectDelayMs?: number;
}

interface InstanceWatchState {
    readonly controller: AbortController;
    lastSeq?: number;
    timer?: ReturnType<typeof setTimeout>;
}

/**
 * Watches `terminal.controlReleased` Instance events and queues a concise
 * handoff Comment to active Contexts sharing that Instance/workspace so the
 * model is proactively informed when a human finishes and hands control back.
 */
export class TerminalHandoffWatcher {
    readonly #options: TerminalHandoffWatcherOptions;
    readonly #reconnectDelayMs: number;
    readonly #watches = new Map<string, InstanceWatchState>();
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
            if (!active.has(name)) this.retireInstance(name);
        }
    }

    retireInstance(instance: string): void {
        const state = this.#watches.get(instance);
        if (state === undefined) return;
        this.#watches.delete(instance);
        if (state.timer !== undefined) clearTimeout(state.timer);
        state.controller.abort();
    }

    close(): void {
        this.#closed = true;
        for (const name of [...this.#watches.keys()]) {
            this.retireInstance(name);
        }
    }

    #startWatch(instance: string): void {
        const state: InstanceWatchState = { controller: new AbortController() };
        this.#watches.set(instance, state);
        void this.#runWatch(instance, state);
    }

    async #runWatch(instance: string, state: InstanceWatchState): Promise<void> {
        while (!this.#closed && !state.controller.signal.aborted) {
            try {
                let fromSeq: number;
                if (state.lastSeq !== undefined) {
                    fromSeq = state.lastSeq + 1;
                } else {
                    const snapshot =
                        await this.#options.instanceObserve.snapshot(instance);
                    if (this.#closed || state.controller.signal.aborted) return;
                    state.lastSeq = snapshot.lastSeq;
                    fromSeq = snapshot.lastSeq + 1;
                }
                await this.#options.instanceObserve.watchEvents(instance, {
                    eventTypes: [TERMINAL_CONTROL_RELEASED_EVENT],
                    fromSeq,
                    onEvent: async (event) => {
                        state.lastSeq = Math.max(
                            state.lastSeq ?? 0,
                            event.seq,
                        );
                        await this.#handleEvent(instance, event);
                    },
                    onGap: (gap) => {
                        state.lastSeq = gap.lastSeq;
                    },
                    signal: state.controller.signal,
                });
            } catch (error) {
                if (this.#closed || state.controller.signal.aborted) return;
                if (isSequenceError(error)) {
                    state.lastSeq = undefined;
                }
                this.#options.onError?.(instance, error);
            }
            if (this.#closed || state.controller.signal.aborted) return;
            await this.#delay(state);
        }
    }

    async #handleEvent(
        instance: string,
        event: ExtensionInstanceEvent,
    ): Promise<void> {
        if (
            event.type !== TERMINAL_CONTROL_RELEASED_EVENT ||
            this.#options.contextObserve === undefined
        )
            return;
        const payload = parseReleasePayload(event.data);
        if (payload === undefined) return;
        const targetWorkspace = normalizeWorkspace(payload.workspace);
        const contexts = await this.#options.contextObserve.list({
            instance,
            status: "active",
        });
        const matching = contexts.filter((ctx) =>
            ctx.environments.some(
                (env) =>
                    env.instance === instance &&
                    normalizeWorkspace(env.workspace) === targetWorkspace,
            ),
        );
        if (matching.length === 0) return;
        const text = formatHandoffComment(payload);
        for (const ctx of matching) {
            try {
                await this.#options.queue(instance, ctx.ctxId, text);
            } catch (error) {
                this.#options.onError?.(instance, error);
            }
        }
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
    return `[Terminal handoff] Human released control of terminal ${label}${suffix}. Inspect the current screen with task_inspect, or send input with task_input (omit any pre-handoff cursor to anchor at the latest output).`;
}

function normalizeWorkspace(
    workspace: string | undefined,
): string | undefined {
    if (workspace === undefined || workspace.length === 0) return undefined;
    if (workspace === "/") return "/";
    const trimmed = workspace.replace(/\/+$/u, "");
    return trimmed.length === 0 ? "/" : trimmed;
}

function isSequenceError(error: unknown): boolean {
    if (error instanceof TypeError) return true;
    if (typeof error === "object" && error !== null) {
        const code = (error as { code?: unknown }).code;
        if (code === "stream.gap" || code === "control.invalidTarget")
            return true;
        const message = (error as { message?: unknown }).message;
        if (typeof message === "string" && /seq|gap/iu.test(message))
            return true;
    }
    return false;
}
