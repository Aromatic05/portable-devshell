import {
    ControlReadModel,
    type ControlReadModelState,
} from "@portable-devshell/shared/browser";

import type { WebClients } from "../client/WebClients.js";
import { WebOperationCoordinator } from "./WebOperationCoordinator.js";
import { withWebRequestTimeout } from "./WebRequestTimeout.js";
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
    readonly #operations: WebOperationCoordinator;
    readonly #requestTimeoutMs: number;
    readonly #offTransportClose: () => void;
    readonly #isPageVisible: () => boolean;
    readonly #overviewRefreshIntervalMs: number;
    #overviewPoll?: ReturnType<typeof setInterval>;
    #overviewRefresh?: ReturnType<typeof setTimeout>;
    #stopped = false;
    #loadPromise?: Promise<void>;
    #reconnectPromise?: Promise<void>;
    #generation = 0;
    #ignoreTransportClose = false;

    constructor(readonly clients: WebClients, options: WebStoreOptions = {}) {
        this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
        this.#isPageVisible = options.isPageVisible ?? (() =>
            typeof document === "undefined" || document.visibilityState !== "hidden"
        );
        this.#overviewRefreshIntervalMs = options.overviewRefreshIntervalMs ?? 5_000;
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
                if (event.type !== "log.appended") this.#scheduleOverview();
            },
            requestTimeoutMs: this.#requestTimeoutMs,
            retryBaseMs: options.streamRetryBaseMs,
            stableAfterMs: options.streamStableAfterMs,
        });
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
        this.#reconcileOverviewPolling();
        return () => {
            this.#listeners.delete(listener);
            this.#reconcileOverviewPolling();
        };
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
                const decided = await this.clients.tool.decideApproval(
                    instance,
                    approvalId,
                    decision,
                );
                if (signal.aborted || !this.#current(generation)) return;
                this.#model.recordToolDecision(instance, decided.approvalId);
                void this.#model.refreshInstance(
                    instance,
                    ["approvals", "todo", "toolCalls", "commentCalls"],
                );
                void this.#model.refreshOverview();
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
                const decided = await this.clients.mcp.decideApproval(approvalId, decision);
                if (signal.aborted || !this.#current(generation)) return;
                this.#model.recordOAuthDecision(decided.approvalId);
                void this.#model.refreshOAuth();
                void this.#model.refreshOverview();
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
            async (signal) => {
                const queued = await this.clients.contextMessage.queue(instance, { ctxId, text });
                if (!signal.aborted && this.#current(generation)) {
                    this.#model.mergeQueuedContextMessage(instance, queued);
                }
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
        this.#stopOverviewPolling();
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
                const snapshot = action === "start"
                    ? await this.clients.runtime.start(instance, { signal })
                    : await this.clients.runtime.stop(instance);
                if (signal.aborted || !this.#current(generation)) return;
                this.#model.applyAuthoritativeSnapshot(snapshot);
                void this.#model.refreshInstance(instance);
                void this.#model.refreshOverview();
            },
        );
    }

    async #reconnect(): Promise<void> {
        this.#generation += 1;
        const generation = this.#generation;
        this.#operations.cancelAll(new Error("Web connection is reconnecting."));
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
            await withWebRequestTimeout(
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
        const model = this.#model.state;
        const approvals: WebState["approvals"] = {};
        const commentCalls: WebState["commentCalls"] = {};
        const contextMessages: WebState["contextMessages"] = {};
        const logs: WebState["logs"] = {};
        const todos: WebState["todos"] = {};
        const toolCalls: WebState["toolCalls"] = {};
        for (const [name, instance] of Object.entries(model.instanceState)) {
            approvals[name] = instance.approvals;
            commentCalls[name] = instance.commentCalls;
            contextMessages[name] = instance.contextMessages;
            logs[name] = instance.logs;
            toolCalls[name] = instance.toolCalls;
            if (instance.todo !== undefined) todos[name] = instance.todo;
        }
        this.#set({
            ...this.#state,
            approvals,
            commentCalls,
            contextMessages,
            instances: model.instances.map((entry) => ({
                ...entry,
                snapshot: model.instanceState[entry.name]?.snapshot ?? entry.snapshot,
            })),
            logs,
            oauthApprovals: model.oauthApprovals,
            overview: model.overview,
            partialFailures: webFailures(model),
            service: model.service,
            todos,
            toolCalls,
        });
    }

    #transportClosed(error: Error): void {
        if (this.#stopped || this.#ignoreTransportClose) return;
        this.#generation += 1;
        this.#operations.cancelAll(error);
        this.#model.reset();
        this.#set({
            ...this.#state,
            connection: "offline",
            error: error.message,
            notice: undefined,
            operations: {},
        });
    }

    #scheduleOverview(): void {
        if (this.#overviewRefresh !== undefined) return;
        this.#overviewRefresh = setTimeout(() => {
            this.#overviewRefresh = undefined;
            if (!this.#stopped) void this.#model.refreshOverview();
        }, 250);
    }

    #reconcileOverviewPolling(): void {
        const active = this.#listeners.size > 0 &&
            this.#state.connection === "online" &&
            this.#overviewRefreshIntervalMs > 0;
        if (!active) {
            this.#stopOverviewPolling();
            return;
        }
        if (this.#overviewPoll !== undefined) return;
        this.#overviewPoll = setInterval(() => {
            if (this.#state.connection === "online" && this.#isPageVisible()) {
                void this.#model.refreshOverview();
            }
        }, this.#overviewRefreshIntervalMs);
    }

    #stopOverviewPolling(): void {
        if (this.#overviewPoll !== undefined) clearInterval(this.#overviewPoll);
        if (this.#overviewRefresh !== undefined) clearTimeout(this.#overviewRefresh);
        this.#overviewPoll = undefined;
        this.#overviewRefresh = undefined;
    }

    #current(generation: number): boolean {
        return !this.#stopped && this.#generation === generation;
    }

    #set(state: WebState): void {
        if (this.#stopped) return;
        const connectionChanged = state.connection !== this.#state.connection;
        this.#state = state;
        if (connectionChanged) this.#reconcileOverviewPolling();
        for (const listener of this.#listeners) listener();
    }
}

function webFailures(model: Readonly<ControlReadModelState>): Record<string, string> {
    return Object.fromEntries(Object.entries(model.failures).map(([key, value]) => {
        if (key.startsWith("snapshot:")) return [`instance:${key.slice(9)}`, value.message];
        if (key.startsWith("todo:")) return [`todos:${key.slice(5)}`, value.message];
        return [key, value.message];
    }));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
