import type {
    WorkspaceReentryDirective,
    WorkspaceSnapshot,
} from "../../model/Contract.js";
import { WorkspaceConnection } from "./Connection.js";
import { WorkspaceHost } from "./Host.js";
import { WorkspacePresentation } from "./Presentation.js";
import { pendingDirectives, WorkspaceReentry } from "./Reentry.js";
import { WorkspaceSession } from "./Session.js";
import { WorkspaceView } from "./View.js";

export interface WorkspaceRuntimeOptions {
    version: string;
    root: HTMLElement;
    status: HTMLElement;
    host?: WorkspaceHost;
    fetcher?: typeof fetch;
}

export class WorkspaceRuntime {
    readonly session = new WorkspaceSession();
    readonly host: WorkspaceHost;
    readonly connection: WorkspaceConnection;
    readonly reentry: WorkspaceReentry;
    readonly presentation: WorkspacePresentation;
    readonly view: WorkspaceView;
    readonly #status: HTMLElement;
    readonly #unsubscribeDisabled: () => void;
    #watchGeneration = 0;
    #activeWatchGeneration?: number;
    #requestSerial = 0;
    #appliedSerial = 0;
    #hostGeneration = 0;
    #modelEpoch = 0;
    #modelContextTail: Promise<unknown> = Promise.resolve();
    #watchController?: AbortController;
    #scheduleTimer?: ReturnType<typeof setTimeout>;
    #modelContextRetryTimer?: ReturnType<typeof setTimeout>;
    #reentryDeliveryInFlight = 0;
    #destroyed = false;
    #reconnectOnStart = true;
    #initialToolResultSeen = false;
    #initialToolResultWait?: () => void;
    #initializing = true;

    constructor(options: WorkspaceRuntimeOptions) {
        this.#status = options.status;
        this.host = options.host ?? new WorkspaceHost(options.version);
        this.connection = new WorkspaceConnection(
            this.session,
            this.host.app,
            options.fetcher,
        );
        this.#unsubscribeDisabled = this.connection.onDisabled(() => {
            if (this.#destroyed) return;
            this.#status.textContent = "Workspace disabled";
            this.#cleanup();
            this.view.clear();
        });
        this.reentry = new WorkspaceReentry(this.connection, this.host);
        this.presentation = new WorkspacePresentation(this.host);
        this.view = new WorkspaceView(options.root, {
            action: (request) => {
                void this.#act(request);
            },
            displayMode: (mode) => {
                void this.presentation.request(mode);
            },
        });
    }

    async start(): Promise<void> {
        this.host.ontoolresult = (result) => {
            const previousCtxId = this.session.state.ctxId;
            if (!this.session.acceptToolResult(result)) return;
            if (this.#initializing) this.#reconnectOnStart = false;
            this.#initialToolResultSeen = true;
            this.#initialToolResultWait?.();
            if (this.session.state.ctxId !== previousCtxId)
                this.#fenceContextReplacement();
            if (!this.#initializing) void this.#startConnection();
        };
        this.host.ontoolinput = (input) => {
            const argumentsValue = record(input).arguments;
            const ctxId = record(argumentsValue).ctxId;
            if (typeof ctxId === "string" && this.session.configure(ctxId))
                void this.#startConnection();
        };
        this.host.ontoolcancelled = (params) => {
            void this.#toolCancelled(params.reason ?? "");
        };
        this.host.onhostcontextchanged = (context) => {
            this.presentation.onHostContextChanged(context);
            this.view.setDisplayMode(context.displayMode ?? "inline");
        };
        this.host.onclose = () => {
            this.presentation.disconnect();
            this.#hostGeneration += 1;
            this.#modelEpoch += 1;
            this.#watchGeneration += 1;
            this.#watchController?.abort();
            void this.#reconnectHost();
        };
        this.host.onteardown = async () => {
            this.#cleanup();
        };
        window.addEventListener("openai:set_globals", this.#onGlobals);
        this.#onGlobals();
        try {
            await this.host.connect();
            if (this.#destroyed) return;
            this.#hostGeneration += 1;
            this.view.setDisplayMode(
                this.host.hostContext.displayMode ?? "inline",
            );
            this.presentation.onGlobals(
                (window as Window & { openai?: unknown }).openai,
            );
            this.presentation.connected();
            if (!this.#initialToolResultSeen)
                await this.#waitForInitialToolResult();
            if (this.#destroyed) return;
            this.#initializing = false;
            if (this.session.state.ctxId) await this.#restoreWorkspace();
            else this.#status.textContent = "Waiting for Workspace context";
        } catch {
            if (this.#destroyed) return;
            if (this.#initializing) {
                this.#status.textContent = "Connecting…";
                this.#retryConnect();
            } else {
                this.#status.textContent = "Reconnecting";
                this.#retryConnection();
            }
        }
    }

    async destroy(): Promise<void> {
        this.#cleanup();
        await this.host.close();
    }

    #cleanup(): void {
        if (this.#destroyed) return;
        this.#destroyed = true;
        this.#modelEpoch += 1;
        this.#unsubscribeDisabled();
        this.#watchGeneration += 1;
        this.#watchController?.abort();
        if (this.#scheduleTimer) clearTimeout(this.#scheduleTimer);
        if (this.#modelContextRetryTimer)
            clearTimeout(this.#modelContextRetryTimer);
        this.presentation.disconnect();
        window.removeEventListener("openai:set_globals", this.#onGlobals);
        this.view.destroy();
    }

    readonly #onGlobals = (event?: Event): void => {
        const globals =
            (event as CustomEvent<{ globals?: unknown }> | undefined)?.detail
                ?.globals ?? (window as Window & { openai?: unknown }).openai;
        if (!this.session.acceptGlobals(globals)) return;
        this.#reconnectOnStart = true;
        this.presentation.onGlobals(globals);
        void this.#startConnection();
    };

    #fenceContextReplacement(): void {
        this.#watchGeneration += 1;
        this.#watchController?.abort();
        this.#modelEpoch += 1;
        if (this.#scheduleTimer) clearTimeout(this.#scheduleTimer);
        this.#scheduleTimer = undefined;
        if (this.#modelContextRetryTimer)
            clearTimeout(this.#modelContextRetryTimer);
        this.#modelContextRetryTimer = undefined;
        this.view.clear();
    }

    async #startConnection(): Promise<void> {
        if (this.#destroyed || this.#initializing || !this.session.state.ctxId) return;
        if (!this.session.state.token) {
            this.#status.textContent = "Waiting for Workspace authorization";
            return;
        }
        if (this.#reconnectOnStart) {
            try {
                await this.#restoreWorkspace();
            } catch {
                this.#status.textContent = "Reconnecting";
                this.#retryConnection();
            }
            return;
        }
        const generation = ++this.#watchGeneration;
        this.#watchController?.abort();
        const controller = new AbortController();
        this.#watchController = controller;
        try {
            const serial = ++this.#requestSerial;
            const snapshot = await this.connection.snapshot(controller.signal);
            if (
                generation !== this.#watchGeneration ||
                controller.signal.aborted
            )
                return;
            await this.#applySnapshot(snapshot, serial);
            this.#status.textContent = "";
            void this.#watch(generation);
        } catch {
            if (this.#destroyed) return;
            if (!controller.signal.aborted) {
                this.#status.textContent = "Reconnecting";
                this.#retryConnection();
            }
        }
    }

    async #restoreWorkspace(): Promise<void> {
        if (this.#destroyed) return;
        if (!this.session.state.token) {
            this.#status.textContent = "Waiting for Workspace authorization";
            return;
        }
        const generation = ++this.#watchGeneration;
        this.#watchController?.abort();
        const state = this.session.state;
        const serial = ++this.#requestSerial;
        const snapshot =
            this.#reconnectOnStart && !(state.token && state.liveBaseUrl)
                ? await this.connection.reconnect()
                : await this.connection.snapshot();
        this.#reconnectOnStart = false;
        if (generation !== this.#watchGeneration) return;
        await this.#applySnapshot(snapshot, serial);
        this.#status.textContent = "";
        if (generation === this.#watchGeneration) void this.#watch(generation);
    }

    async #waitForInitialToolResult(): Promise<void> {
        if (this.#initialToolResultSeen) return;
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                this.#initialToolResultWait = undefined;
                resolve();
            }, 300);
            this.#initialToolResultWait = () => {
                clearTimeout(timer);
                this.#initialToolResultWait = undefined;
                resolve();
            };
        });
        if (!this.#initialToolResultSeen) this.#reconnectOnStart = true;
    }

    async #watch(generation: number): Promise<void> {
        this.#activeWatchGeneration = generation;
        while (!this.#destroyed && generation === this.#watchGeneration) {
            const controller = new AbortController();
            this.#watchController = controller;
            const serial = ++this.#requestSerial;
            try {
                const result = await this.connection.watch(controller.signal);
                if (
                    generation !== this.#watchGeneration ||
                    controller.signal.aborted
                )
                    return;
                if (result.snapshot)
                    await this.#applySnapshot(result.snapshot, serial);
                this.#status.textContent = "";
            } catch {
                if (
                    controller.signal.aborted ||
                    generation !== this.#watchGeneration
                )
                    return;
                this.#status.textContent = "Reconnecting";
                await this.#startConnection();
                return;
            }
        }
    }

    async #applySnapshot(
        snapshot: WorkspaceSnapshot,
        serial: number,
        effect?: WorkspaceReentryDirective,
    ): Promise<void> {
        if (this.#destroyed) return;
        if (snapshot.ctxId !== this.session.state.ctxId)
            throw new Error(
                "Workspace snapshot belongs to a different Context",
            );
        const contextGeneration = this.session.generation;
        const appliedCursor = this.view.snapshot?.cursor ?? -1;
        if (
            snapshot.cursor < this.connection.cursor ||
            snapshot.cursor < appliedCursor ||
            (snapshot.cursor === appliedCursor &&
                serial < this.#appliedSerial)
        )
            return;
        this.#appliedSerial = Math.max(this.#appliedSerial, serial);
        this.connection.acceptSnapshot(snapshot);
        this.view.setSnapshot(snapshot);
        await this.#syncModelContext(snapshot);
        if (this.#destroyed || !this.session.isCurrent(contextGeneration, snapshot.ctxId)) return;
        this.#scheduleAutomatic(snapshot);
        if (!snapshot.agentBusy && !snapshot.reentry.executionActive) {
            const directives = pendingDirectives(snapshot, effect).filter(
                (item) =>
                    !(item.intent === "automatic" && snapshot.reentry.schedule),
            );
            for (const directive of directives) {
                const refreshed = await this.#deliverReentry(directive);
                if (!this.session.isCurrent(contextGeneration, snapshot.ctxId))
                    return;
                if (refreshed.ctxId === snapshot.ctxId)
                    this.view.setSnapshot(refreshed);
            }
        }
    }

    async #act(request: {
        itemId: string;
        actionId: string;
        input?: string;
    }): Promise<void> {
        this.view.setBusy(request.actionId, true);
        const serial = ++this.#requestSerial;
        try {
            const result = await this.connection.action(request);
            await this.#applySnapshot(result.snapshot, serial, result.effect);
            if (result.status === "stale")
                this.#status.textContent = "State changed; review and retry";
        } catch {
            if (this.#destroyed) return;
            this.#status.textContent = "Action failed; reconnecting";
            await this.#startConnection();
        } finally {
            this.view.setBusy(request.actionId, false);
        }
    }

    async #toolCancelled(reason: string): Promise<void> {
        if (/user|stop/iu.test(reason)) {
            if (this.#scheduleTimer) clearTimeout(this.#scheduleTimer);
            this.#scheduleTimer = undefined;
            try {
                await this.connection.reentry({
                    action: "yield",
                    reason: reason || "user interrupted automatic execution",
                });
            } catch {}
        } else if (
            this.#activeWatchGeneration === this.#watchGeneration &&
            this.#watchController &&
            !this.#watchController.signal.aborted
        ) {
            return;
        }
        if (this.session.state.ctxId) await this.#startConnection();
    }

    async #readUpdatedSnapshot(): Promise<WorkspaceSnapshot> {
        const serial = ++this.#requestSerial;
        const fence = this.connection.fence();
        const snapshot = await this.connection.snapshot();
        this.connection.assertCurrent(fence);
        if (
            snapshot.ctxId === this.session.state.ctxId &&
            snapshot.cursor >= this.connection.cursor &&
            serial >= this.#appliedSerial
        ) {
            this.#appliedSerial = serial;
            this.connection.acceptSnapshot(snapshot);
            this.view.setSnapshot(snapshot);
            await this.#syncModelContext(snapshot);
            this.connection.assertCurrent(fence);
            this.#scheduleAutomatic(snapshot);
        }
        return snapshot;
    }

    async #deliverReentry(
        directive: WorkspaceReentryDirective,
    ): Promise<WorkspaceSnapshot> {
        this.#reentryDeliveryInFlight += 1;
        try {
            const refreshed = await this.reentry.deliver(
                directive,
                async () => await this.#readUpdatedSnapshot(),
            );
            return refreshed;
        } finally {
            this.#reentryDeliveryInFlight -= 1;
            if (this.#reentryDeliveryInFlight === 0 && this.view.snapshot)
                this.#scheduleModelContextSync();
        }
    }

    async #syncModelContext(snapshot: WorkspaceSnapshot): Promise<void> {
        if (this.#reentryDeliveryInFlight > 0) {
            this.#scheduleModelContextSync();
            return;
        }
        const hostGeneration = this.#hostGeneration;
        const modelEpoch = ++this.#modelEpoch;
        const operation = this.#modelContextTail.then(async () => {
            if (
                hostGeneration !== this.#hostGeneration ||
                modelEpoch !== this.#modelEpoch
            )
                return;
            await this.host.updateModelContext(snapshot.modelContext);
        });
        this.#modelContextTail = operation.catch(() => undefined);
        await operation.catch(() => {
            if (!this.#destroyed && hostGeneration === this.#hostGeneration && modelEpoch === this.#modelEpoch)
                this.#scheduleModelContextSync();
        });
    }

    #scheduleModelContextSync(): void {
        if (this.#modelContextRetryTimer || this.#destroyed) return;
        this.#modelContextRetryTimer = setTimeout(() => {
            this.#modelContextRetryTimer = undefined;
            if (this.#reentryDeliveryInFlight === 0 && this.view.snapshot)
                void this.#syncModelContext(this.view.snapshot);
        }, 1_000);
    }

    #scheduleAutomatic(snapshot: WorkspaceSnapshot): void {
        if (this.#scheduleTimer) clearTimeout(this.#scheduleTimer);
        this.#scheduleTimer = undefined;
        const schedule = snapshot.reentry.schedule;
        if (!schedule || snapshot.agentBusy || snapshot.reentry.executionActive)
            return;
        const readyAt = Date.parse(schedule.readyAt);
        if (!Number.isFinite(readyAt)) return;
        const delay = Math.max(0, readyAt - Date.now());
        this.#scheduleTimer = setTimeout(
            () => {
                this.#scheduleTimer = undefined;
                const current = this.view.snapshot;
                if (
                    !current ||
                    current.reentry.schedule?.readyAt !== schedule.readyAt ||
                    current.agentBusy ||
                    current.reentry.executionActive
                )
                    return;
                const directive = pendingDirectives(current).find(
                    (item) =>
                        item.intent === schedule.intent &&
                        (schedule.sourceId === undefined ||
                            item.sourceId === schedule.sourceId),
                ) ?? {
                    kind: "reentry" as const,
                    intent: schedule.intent,
                    ...(schedule.sourceId
                        ? { sourceId: schedule.sourceId }
                        : {}),
                };
                const fence = this.connection.fence();
                void this.#deliverReentry(directive)
                    .then((next) => {
                        if (
                            !this.#destroyed &&
                            this.session.isCurrent(
                                fence.generation,
                                fence.ctxId,
                            ) &&
                            next.ctxId === fence.ctxId
                        )
                            this.view.setSnapshot(next);
                    })
                    .catch(() => undefined);
            },
            Math.min(2_147_483_647, delay),
        );
    }

    async #reconnectHost(): Promise<void> {
        if (this.#destroyed) return;
        this.#initializing = true;
        try {
            await this.host.reconnect();
            if (this.#destroyed) return;
            this.#hostGeneration += 1;
            this.view.setDisplayMode(
                this.host.hostContext.displayMode ?? "inline",
            );
            this.presentation.connected();
            this.#reconnectOnStart = true;
            this.#initializing = false;
            await this.#restoreWorkspace();
        } catch {
            if (this.#destroyed) return;
            if (this.#initializing) this.#retryConnect();
            else this.#retryConnection();
        }
    }

    #retryConnect(): void {
        if (!this.#destroyed)
            setTimeout(() => {
                void this.#reconnectHost();
            }, 1_000);
    }
    #retryConnection(): void {
        if (!this.#destroyed)
            setTimeout(() => {
                void this.#startConnection();
            }, 1_000);
    }
}

function record(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}
