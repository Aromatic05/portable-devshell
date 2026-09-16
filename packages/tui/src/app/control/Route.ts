import { type TuiAppStore } from "../../state/store/App.js";
import { selectTuiLogs } from "../../state/store/Model.js";
import { type TuiControlSession } from "./Session.js";
import { tuiRouteIdentity, type TuiRoute } from "../../state/route/Model.js";
import { currentTuiRoute } from "../../state/route/State.js";

export class TuiRouteDataLoader {
    constructor(
        private readonly options: {
            session: TuiControlSession;
            store: TuiAppStore;
        },
    ) {}

    async enter(
        context: TuiRouteLifecycleContext,
    ): Promise<void | (() => void)> {
        const { instance, route, signal } = context;
        switch (route.page) {
            case "overview":
                await this.options.session.refreshOverview(undefined, signal);
                return;
            case "instances":
            case "config":
                await this.options.session.refreshConfig(undefined, signal);
                return;
            case "connections":
                await Promise.all([
                    this.options.session.refreshConfig(undefined, signal),
                    this.options.session.refreshOAuth(undefined, signal),
                ]);
                return;
            case "audit":
                if (instance !== undefined)
                    await this.options.session.refreshAudit(
                        instance,
                        undefined,
                        signal,
                    );
                return;
            case "messages":
                await this.options.session.refreshMessages(undefined, signal);
                return;
            case "todo":
                if (instance !== undefined) {
                    const input =
                        route.view === "detail"
                            ? { taskId: route.todoId }
                            : undefined;
                    await this.options.session.refreshTodo(
                        instance,
                        undefined,
                        signal,
                        input,
                    );
                }
                return;
            case "logs":
                if (instance === undefined) return;
                await this.options.session.refreshLogsForInstance(
                    instance,
                    undefined,
                    signal,
                );
                if (route.view === "context") {
                    this.options.store.setLogsFollow(instance, true);
                    return () => {
                        const logs = selectTuiLogs(
                            this.options.store.getState(),
                            instance,
                        );
                        this.options.store.setLogsFollow(instance, false);
                        this.options.store.setLogsPausedAtSeq(
                            instance,
                            logs.at(-1)?.seq,
                        );
                    };
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
