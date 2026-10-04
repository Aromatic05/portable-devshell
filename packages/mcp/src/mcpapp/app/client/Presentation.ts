import type { McpAppDisplayMode, McpAppHostAdapter, McpAppHostContext, McpAppWidgetState } from "./Host.js";

const TRANSITION_KEY = "portableDevshellPresentation";
const TRANSITION_LEASE_MS = 2_000;
const RETRY_DELAY_MS = 750;
const MAX_RETRIES = 2;
type PresentationHost = Pick<McpAppHostAdapter, "requestDisplayMode"> & {
    readonly hostContext: Readonly<McpAppHostContext>;
    readWidgetState(): McpAppWidgetState;
    writeWidgetState(state: McpAppWidgetState): void;
};

export class McpAppPresentation {
    readonly #host: PresentationHost;
    #generation = 0;
    #requestGeneration = 0;
    #retryCount = 0;
    #retryTimer?: ReturnType<typeof setTimeout>;
    #settleTimer?: ReturnType<typeof setTimeout>;
    #claimPending = false;
    #transitionSettling = false;
    #handoffPending = false;
    #disposed = false;

    constructor(host: PresentationHost) { this.#host = host; }
    get displayMode(): McpAppDisplayMode { return this.#host.hostContext.displayMode ?? "inline"; }
    get transitionSettling(): boolean { return this.#transitionSettling; }

    connected(): void {
        this.#generation += 1;
        this.#retryCount = 0;
        this.#claimPending = true;
        this.#disposed = false;
        void this.#requestPreferredMode(!this.#transitionSettling, this.#generation);
    }

    onHostContextChanged(context: McpAppHostContext): void {
        if (!this.#claimPending) return;
        if (this.#handoffPending && context.displayMode === "pip") { this.#complete(); return; }
        void this.#requestPreferredMode(!this.#transitionSettling && !this.#handoffPending, this.#generation, context);
    }

    onGlobals(globals: unknown): void {
        const transition = this.#transitionFrom(globals);
        if (!transition || transition.mode !== this.displayMode) return;
        this.#consumeTransition();
        const remaining = Math.max(0, transition.expiresAt - Date.now());
        if (remaining > 0) this.#settle(remaining);
    }

    async request(mode: McpAppDisplayMode): Promise<void> {
        this.#generation += 1;
        this.#retryCount = 0;
        this.#claimPending = true;
        this.#transitionSettling = false;
        this.#handoffPending = false;
        await this.#requestPreferredMode(true, this.#generation, this.#host.hostContext, mode);
    }

    disconnect(): void {
        this.#disposed = true;
        this.#generation += 1;
        this.#claimPending = false;
        this.#transitionSettling = false;
        this.#handoffPending = false;
        this.#requestGeneration = 0;
        if (this.#retryTimer) clearTimeout(this.#retryTimer);
        if (this.#settleTimer) clearTimeout(this.#settleTimer);
        this.#retryTimer = undefined;
        this.#settleTimer = undefined;
    }

    async #requestPreferredMode(force: boolean, generation: number, context = this.#host.hostContext, requestedMode: McpAppDisplayMode = "pip"): Promise<void> {
        if (this.#disposed || generation !== this.#generation || this.#requestGeneration === generation) return;
        const modes = context.availableDisplayModes;
        if (!modes) return;
        if (!modes.includes(requestedMode)) { this.#complete(); return; }
        if (this.#transitionSettling && context.displayMode === requestedMode) return;
        const transitionRemaining = context.displayMode === requestedMode ? this.#consumeMatchingTransition(requestedMode) : 0;
        if (transitionRemaining > 0) { this.#settle(transitionRemaining); return; }
        if (context.displayMode === requestedMode && !force) { this.#complete(); return; }
        this.#requestGeneration = generation;
        this.#writeTransition(requestedMode);
        try {
            const actualMode = await this.#host.requestDisplayMode(requestedMode);
            if (generation !== this.#generation) return;
            if (actualMode === requestedMode) { this.#consumeTransition(); this.#complete(); }
            else this.#scheduleRetry(generation, requestedMode);
        } catch {
            this.#scheduleRetry(generation, requestedMode);
        } finally {
            if (this.#requestGeneration === generation) this.#requestGeneration = 0;
        }
    }

    #scheduleRetry(generation: number, mode: McpAppDisplayMode): void {
        if (generation !== this.#generation || this.#disposed || !this.#claimPending || this.#retryTimer) return;
        if (this.#retryCount >= MAX_RETRIES) { this.#complete(); return; }
        this.#retryCount += 1;
        this.#retryTimer = setTimeout(() => {
            this.#retryTimer = undefined;
            void this.#requestPreferredMode(!this.#transitionSettling, generation, this.#host.hostContext, mode);
        }, RETRY_DELAY_MS * this.#retryCount);
    }

    #complete(): void {
        this.#claimPending = false;
        this.#transitionSettling = false;
        this.#handoffPending = false;
        this.#requestGeneration = 0;
        this.#retryCount = 0;
        if (this.#retryTimer) clearTimeout(this.#retryTimer);
        if (this.#settleTimer) clearTimeout(this.#settleTimer);
        this.#retryTimer = undefined;
        this.#settleTimer = undefined;
    }

    #settle(remaining: number): void {
        this.#transitionSettling = true;
        this.#handoffPending = true;
        if (this.#retryTimer) clearTimeout(this.#retryTimer);
        if (this.#settleTimer) clearTimeout(this.#settleTimer);
        this.#retryTimer = undefined;
        this.#settleTimer = setTimeout(() => { this.#settleTimer = undefined; this.#transitionSettling = false; }, Math.max(1, remaining));
    }

    #consumeMatchingTransition(mode: McpAppDisplayMode): number {
        const transition = this.#transitionFrom(this.#host.readWidgetState());
        if (!transition || transition.mode !== mode) return 0;
        this.#consumeTransition();
        return Math.max(0, transition.expiresAt - Date.now());
    }

    #transitionFrom(source: unknown): { mode: string; expiresAt: number } | undefined {
        const root = record(source);
        const widgetState = record(root.widgetState ?? root);
        const privateContent = record(widgetState.privateContent);
        const value = record(privateContent[TRANSITION_KEY]);
        return typeof value.mode === "string" && typeof value.expiresAt === "number" ? { mode: value.mode, expiresAt: value.expiresAt } : undefined;
    }

    #writeTransition(mode: McpAppDisplayMode): void {
        const current = this.#host.readWidgetState();
        const privateContent = { ...record(current.privateContent), [TRANSITION_KEY]: { mode, expiresAt: Date.now() + TRANSITION_LEASE_MS } };
        this.#host.writeWidgetState({ modelContent: current.modelContent ?? null, privateContent, imageIds: current.imageIds ?? [] });
    }

    #consumeTransition(): void {
        const current = this.#host.readWidgetState();
        const privateContent = { ...record(current.privateContent) };
        delete privateContent[TRANSITION_KEY];
        this.#host.writeWidgetState({ modelContent: current.modelContent ?? null, privateContent, imageIds: current.imageIds ?? [] });
    }
}

function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
