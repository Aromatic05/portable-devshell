import { tuiRouteIdentity, type TuiRoute } from "../../state/route/TuiRoute.js";
import { currentTuiRoute } from "../../state/route/TuiRouteState.js";
import type { TuiAppStore } from "../../state/TuiAppStore.js";

export interface TuiRouteLifecycleContext {
    instance?: string;
    route: TuiRoute;
    signal: AbortSignal;
}

export interface TuiRouteLifecycleControllerOptions {
    onEnter(context: TuiRouteLifecycleContext): Promise<void | (() => void)>;
    onError?(context: Omit<TuiRouteLifecycleContext, "signal">, error: unknown): void;
    store: TuiAppStore;
}

export class TuiRouteLifecycleController {
    readonly #options: TuiRouteLifecycleControllerOptions;
    #abort?: AbortController;
    #cleanup?: () => void;
    #key?: string;
    #running = false;
    #unsubscribe?: () => void;

    constructor(options: TuiRouteLifecycleControllerOptions) {
        this.#options = options;
    }

    start(skipInitialEnter = false): void {
        if (this.#running) return;
        this.#running = true;
        this.#unsubscribe = this.#options.store.subscribe(() => this.#sync());
        if (skipInitialEnter) {
            this.#key = this.#currentKey();
        } else {
            this.#sync();
        }
    }

    stop(): void {
        if (!this.#running) return;
        this.#running = false;
        this.#unsubscribe?.();
        this.#unsubscribe = undefined;
        this.#leave();
        this.#key = undefined;
    }

    #sync(): void {
        if (!this.#running) return;
        const state = this.#options.store.getState();
        const route = currentTuiRoute(state);
        const instance = state.ui.selectedInstance;
        const key = this.#currentKey();
        if (key === this.#key) return;
        this.#leave();
        this.#key = key;
        const abort = new AbortController();
        this.#abort = abort;
        const context = { instance, route, signal: abort.signal };
        void this.#options.onEnter(context).then(
            (cleanup) => {
                if (!this.#running || this.#abort !== abort || abort.signal.aborted) {
                    cleanup?.();
                    return;
                }
                this.#cleanup = typeof cleanup === "function" ? cleanup : undefined;
            },
            (error: unknown) => {
                if (!abort.signal.aborted) this.#options.onError?.({ instance, route }, error);
            }
        );
    }

    #currentKey(): string {
        const state = this.#options.store.getState();
        return `${state.ui.selectedInstance ?? "-"}\u0000${tuiRouteIdentity(currentTuiRoute(state))}`;
    }

    #leave(): void {
        this.#abort?.abort();
        this.#abort = undefined;
        this.#cleanup?.();
        this.#cleanup = undefined;
    }
}
