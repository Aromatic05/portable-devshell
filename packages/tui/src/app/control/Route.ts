import { type TuiAppStore } from "../../state/store/App.js";
import { type TuiDomainSession } from "./Client.js";
import { tuiRouteIdentity, type TuiRoute } from "../../state/route/Model.js";
import { currentTuiRoute } from "../../state/route/State.js";
import {
    refreshTuiAudit,
    refreshTuiMessages,
    refreshTuiTodo,
} from "./Refresh.js";

/**
 * Loads the data a route needs on entry. It coordinates the existing domain
 * ViewModels directly; it holds no refresh API of its own.
 */
export class TuiRouteDataLoader {
    constructor(
        private readonly options: {
            domains: TuiDomainSession;
            store: TuiAppStore;
        },
    ) {}

    async enter(
        context: TuiRouteLifecycleContext,
    ): Promise<void | (() => void)> {
        const { instance, route, signal } = context;
        const domains = this.options.domains;
        switch (route.page) {
            case "overview":
                if (signal.aborted) return;
                await domains.overview.refresh();
                return;
            case "instances":
            case "config":
                if (signal.aborted) return;
                await domains.config.refresh();
                return;
            case "connections":
                if (signal.aborted) return;
                await Promise.all([
                    domains.config.refresh(),
                    domains.mcp.refresh(),
                ]);
                return;
            case "audit":
                if (instance !== undefined) {
                    if (signal.aborted) return;
                    await refreshTuiAudit(domains, instance);
                }
                return;
            case "messages":
                if (signal.aborted) return;
                await refreshTuiMessages(domains);
                return;
            case "todo":
                if (instance !== undefined) {
                    if (signal.aborted) return;
                    const input =
                        route.view === "detail"
                            ? { taskId: route.todoId }
                            : undefined;
                    await refreshTuiTodo(domains, instance, input);
                }
                return;
            case "extensions":
                if (route.view === "page") {
                    if (signal.aborted) return;
                    await domains.extension.readTuiPage(route.pageId);
                }
                return;
            case "help":
            case "terminal":
                return;
        }
    }
}

export interface TuiRouteLifecycleContext {
    instance?: string;
    route: TuiRoute;
    signal: AbortSignal;
}

export interface TuiRouteLifecycleControllerOptions {
    onEnter(context: TuiRouteLifecycleContext): Promise<void | (() => void)>;
    onError?(
        context: Omit<TuiRouteLifecycleContext, "signal">,
        error: unknown,
    ): void;
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
                if (
                    !this.#running ||
                    this.#abort !== abort ||
                    abort.signal.aborted
                ) {
                    cleanup?.();
                    return;
                }
                this.#cleanup =
                    typeof cleanup === "function" ? cleanup : undefined;
            },
            (error: unknown) => {
                if (!abort.signal.aborted)
                    this.#options.onError?.({ instance, route }, error);
            },
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
