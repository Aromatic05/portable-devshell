import {
    ControlCommands,
    ControlReadModel,
    ControlRefreshScheduler,
    errorMessage,
    withRequestTimeout,
} from "@portable-devshell/shared/browser";

import type { WebClients } from "../client/WebClients.js";
import { WebOperationCoordinator } from "./WebOperationCoordinator.js";
import { createInitialWebState, type WebState } from "./WebState.js";

export type { ConnectionState, WebState } from "./WebState.js";

export interface WebStoreOptions {
    isPageVisible?: () => boolean;
    operationTimeoutMs?: number;
    overviewRefreshIntervalMs?: number;
    requestTimeoutMs?: number;
    streamRetryBaseMs?: number;
    streamStableAfterMs?: number;
}

export class WebStore {
    #state = createInitialWebState();
    readonly #listeners = new Set<() => void>();
    readonly #model: ControlReadModel;
    readonly #commands: ControlCommands;
    readonly #operations: WebOperationCoordinator;
    readonly #requestTimeoutMs: number;
    readonly #offTransportClose: () => void;
    readonly #refreshScheduler: ControlRefreshScheduler;
    #stopped = false;
    #loadPromise?: Promise<void>;
    #reconnectPromise?: Promise<void>;
    #generation = 0;
    #ignoreTransportClose = false;

    constructor(readonly clients: WebClients, options: WebStoreOptions = {}) {
        this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
        const isPageVisible = options.isPageVisible ?? (() =>
            typeof document === "undefined" || document.visibilityState !== "hidden"
        );
        this.#operations = new WebOperationCoordinator(
            {
                getState: () => this.#state,
                isCurrent: (generation) => this.#current(generation),
                setState: (state) => this.#set(state),
            },
            options.operationTimeoutMs ?? 30_000,
        );
        this.#model = new ControlReadModel({
            clients,
            onEvent: (event) => {
                if (event.type !== "log.appended") this.#refreshScheduler.scheduleOverview(250);
            },
            requestTimeoutMs: this.#requestTimeoutMs,
            retryBaseMs: options.streamRetryBaseMs,
            stableAfterMs: options.streamStableAfterMs,
        });
        this.#commands = new ControlCommands({
            clients,
            model: this.#model,
            timeoutMs: options.operationTimeoutMs ?? 30_000,
        });
        this.#refreshScheduler = new ControlRefreshScheduler({
            model: this.#model,
            overviewIntervalMs: options.overviewRefreshIntervalMs,
            shouldRefreshOAuth: () => {
                const status = this.#model.state.mcpStatus;
                return this.#listeners.size > 0 &&
                    this.#state.connection === "online" &&
                    isPageVisible() &&
                    status?.authMode === "oauth2" &&
                    status.oauthReady === true &&
                    status.running === true;
            },
            shouldRefreshOverview: () =>
                this.#listeners.size > 0 &&
                this.#state.connection === "online" &&
                isPageVisible(),
        });
        this.#refreshScheduler.start();
        this.#model.subscribe(() => this.#syncModel());
        this.#offTransportClose = clients.onTransportClose((error) =>
            this.#transportClosed(error)
        );
    }

    get state(): WebState {
        return this.#state;
    }

    readonly subscribe = (listener: () => void): (() => void) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    };

    async load(): Promise<void> {
        if (this.#stopped) return;
        if (this.#loadPromise !== undefined) return await this.#loadPromise;
        const generation = this.#generation;
        this.#set({ ...this.#state, connection: "connecting", error: undefined });
        const request = this.#model.load().then(
            () => {
                if (this.#current(generation)) {
                    this.#set({ ...this.#state, connection: "online", error: undefined });
                }
            },
            (error: unknown) => {
                if (this.#current(generation)) {
                    this.#set({
                        ...this.#state,
                        connection: "offline",
                        error: errorMessage(error),
                    });
                }
            },
        ).finally(() => {
            if (this.#loadPromise === request) this.#loadPromise = undefined;
        });
        this.#loadPromise = request;
        return await request;
    }

    async reconnect(): Promise<void> {
        if (this.#reconnectPromise !== undefined) return await this.#reconnectPromise;
        const request = this.#reconnect().finally(() => {
            if (this.#reconnectPromise === request) this.#reconnectPromise = undefined;
        });
        this.#reconnectPromise = request;
        return await request;
    }

    async refreshInstance(name: string): Promise<void> {
        await this.#model.refreshInstance(name);
    }

    async decideTool(
        instance: string,
        approvalId: string,
        decision: "approve" | "deny",
    ): Promise<void> {
        const generation = this.#generation;
        await this.#operations.run(
            `approval:${approvalId}`,
            "Approval recorded.",
            generation,
            async (signal) => {
                await this.#commands.decideToolApproval(instance, approvalId, decision);
                if (signal.aborted || !this.#current(generation)) return;
            },
        );
    }

    async decideOAuth(
        approvalId: string,
        decision: "approve" | "deny",
    ): Promise<void> {
        const generation = this.#generation;
        await this.#operations.run(
            `oauth:${approvalId}`,
            "Approval recorded.",
            generation,
            async (signal) => {
                await this.#commands.decideOAuthApproval(approvalId, decision);
                if (signal.aborted || !this.#current(generation)) return;
            },
        );
    }

    async queueContextMessage(
        instance: string,
        ctxId: string,
        text: string,
    ): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `context-message:${instance}:${ctxId}`,
            "Message queued.",
            generation,
            async (_signal) => {
                await this.#commands.queueContextMessage(instance, ctxId, text);
            },
        );
    }

    async disableContext(ctxId: string): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `context-disable:${ctxId}`,
            "Context disabled.",
            generation,
            async (signal) => {
                await this.#commands.disableContext(ctxId);
                if (signal.aborted || !this.#current(generation)) return;
            },
        );
    }

    async renewContext(ctxId: string): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `context-renew:${ctxId}`,
            "Context renewed.",
            generation,
            async (signal) => {
                await this.#commands.renewContext(ctxId);
                if (signal.aborted || !this.#current(generation)) return;
            },
        );
    }

    async deleteTodo(instance: string, taskId: string): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `todo-delete:${instance}:${taskId}`,
            "Todo project deleted.",
            generation,
            async () => {
                await this.clients.todo.delete(instance, taskId);
                if (this.#current(generation)) await this.#model.refreshInstance(instance, ["todo"]);
            },
        );
    }

    async start(instance: string): Promise<void> {
        await this.#lifecycle(instance, "start");
    }

    async stop(instance: string): Promise<void> {
        await this.#lifecycle(instance, "stop");
    }

    close(): void {
        if (this.#stopped) return;
        this.#stopped = true;
        this.#generation += 1;
        this.#offTransportClose();
        this.#operations.cancelAll(new Error("Web store closed."));
        this.#commands.reset();
        this.#refreshScheduler.stop();
        this.#model.close();
        this.clients.close();
    }

    async #lifecycle(instance: string, action: "start" | "stop"): Promise<void> {
        const generation = this.#generation;
        await this.#operations.run(
            `${action}:${instance}`,
            `${instance} ${action} requested.`,
            generation,
            async (signal) => {
                if (action === "start") {
                    await this.#commands.startInstance(instance, { signal });
                } else {
                    await this.#commands.stopInstance(instance);
                }
            },
        );
    }

    async #reconnect(): Promise<void> {
        this.#generation += 1;
        const generation = this.#generation;
        this.#operations.cancelAll(new Error("Web connection is reconnecting."));
        this.#commands.reset();
        this.#model.reset();
        this.#set({
            ...this.#state,
            connection: "connecting",
            error: undefined,
            notice: undefined,
            operations: {},
        });
        this.#ignoreTransportClose = true;
        try {
            await withRequestTimeout(
                this.clients.reconnect(),
                this.#requestTimeoutMs,
                "control.reconnect",
            );
        } catch (error) {
            if (this.#current(generation)) {
                this.#set({ ...this.#state, connection: "offline", error: errorMessage(error) });
            }
            return;
        } finally {
            this.#ignoreTransportClose = false;
        }
        if (this.#current(generation)) await this.load();
    }

    #syncModel(): void {
        if (this.#stopped) return;
        this.#set({ ...this.#state, readModel: this.#model.state });
    }

    #transportClosed(error: Error): void {
        if (this.#stopped || this.#ignoreTransportClose) return;
        this.#generation += 1;
        this.#operations.cancelAll(error);
        this.#commands.reset();
        this.#model.reset();
        this.#set({
            ...this.#state,
            connection: "offline",
            error: error.message,
            notice: undefined,
            operations: {},
        });
    }

    #current(generation: number): boolean {
        return !this.#stopped && this.#generation === generation;
    }

    #set(state: WebState): void {
        if (this.#stopped) return;
        this.#state = state;
        for (const listener of this.#listeners) listener();
    }
}
