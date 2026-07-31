import {
    createTuiClients as createControlClients,
    type TuiClients
} from "../client/TuiClientComposition.js";
import type { TuiClientRuntimeStreamMessage } from "../client/runtime/TuiClientRuntimeStream.js";
import { TuiAppStore } from "../../state/TuiAppStore.js";
import {
    readTuiControlErrorCode,
    TuiControlSessionRefresh
} from "./TuiControlSessionRefresh.js";
import { TuiControlSessionSubscriptions } from "./TuiControlSessionSubscriptions.js";
import { selectMainScrollKey } from "../../view/model/TuiViewProjection.js";

export interface TuiControlSessionOptions {
    clients?: TuiClients;
    overviewRefreshIntervalMs?: number;
    store?: TuiAppStore;
}

export class TuiControlSession {
    readonly #clients: TuiClients;
    readonly #refresh: TuiControlSessionRefresh;
    readonly #overviewRefreshIntervalMs: number;
    readonly #store: TuiAppStore;
    readonly #subscriptions: TuiControlSessionSubscriptions;
    readonly #auditRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
    #oauthRefreshTimer?: ReturnType<typeof setInterval>;
    #overviewPollTimer?: ReturnType<typeof setInterval>;
    #overviewRefreshRequest?: Promise<void>;
    #overviewRefreshGeneration?: number;
    #overviewRefreshTimer?: ReturnType<typeof setTimeout>;
    #started = false;
    #generation = 0;

    constructor(options: TuiControlSessionOptions = {}) {
        this.#clients = options.clients ?? createControlClients();
        this.#overviewRefreshIntervalMs = options.overviewRefreshIntervalMs ?? 5_000;
        this.#store = options.store ?? new TuiAppStore();
        this.#refresh = new TuiControlSessionRefresh({
            clients: this.#clients,
            isCurrent: (generation) => this.#current(generation),
            store: this.#store
        });
        this.#subscriptions = new TuiControlSessionSubscriptions({
            onConnectionClosed: () => {
                this.#handleDisconnected();
            },
            onEvent: (message) => {
                this.#handleInstanceEvent(message);
            },
            onGap: async (instance) => {
                await this.#recoverInstanceSubscription(instance);
            },
            onSubscribeError: async (instance, error) => {
                await this.#handleSubscribeError(instance, error);
            },
            subscribe: async (instance, fromSeq) => {
                return await this.#clients.runtime.subscribe(instance, fromSeq);
            }
        });
    }

    get store(): TuiAppStore {
        return this.#store;
    }

    async start(): Promise<void> {
        if (this.#started) {
            return;
        }
        this.#started = true;
        const generation = ++this.#generation;
        await this.refresh(generation);
        if (this.#current(generation) && this.#store.getState().connection.status === "connected") {
            this.#startOAuthRefresh();
            this.#startOverviewPolling();
        }
    }

    async stop(): Promise<void> {
        this.#generation += 1;
        this.#started = false;
        this.#stopOAuthRefresh();
        this.#stopOverviewPolling();
        this.#stopOverviewRefresh();
        this.#stopAuditRefreshes();
        this.#subscriptions.closeAll();
        this.#clients.close();
    }

    async reconnect(): Promise<void> {
        if (!this.#started) {
            return;
        }
        const generation = ++this.#generation;
        this.#stopOAuthRefresh();
        this.#stopOverviewPolling();
        try {
            await this.#clients.reconnect();
            if (!this.#current(generation)) return;
            await this.refresh(generation);
            if (this.#current(generation) && this.#store.getState().connection.status === "connected") {
                this.#startOAuthRefresh();
                this.#startOverviewPolling();
            }
        } catch (error) {
            if (this.#current(generation)) this.#applyConnectionFailure(error);
        }
    }

    async refreshConfig(generation = this.#generation, signal?: AbortSignal): Promise<void> {
        await this.#refresh.refreshConfig(generation, signal);
        if (this.#current(generation) && this.#store.getState().connection.status === "connected") {
            this.#stopOAuthRefresh();
            this.#startOAuthRefresh();
        }
    }

    async refreshOverview(generation = this.#generation, signal?: AbortSignal): Promise<void> {
        if (signal?.aborted !== true) await this.#requestOverviewRefresh(generation);
    }

    async refreshOAuth(generation = this.#generation, signal?: AbortSignal): Promise<void> {
        await this.#refresh.refreshOAuth(generation, signal);
    }

    async refreshAudit(instance: string, generation = this.#generation, signal?: AbortSignal): Promise<void> {
        await this.#refresh.refreshAudit(instance, generation, signal);
    }

    async refreshLogsForInstance(instance: string, generation = this.#generation, signal?: AbortSignal): Promise<void> {
        await this.#refresh.refreshLogsForInstance(instance, generation, signal);
    }

    async refreshTodo(instance: string, generation = this.#generation, signal?: AbortSignal): Promise<void> {
        await this.#refresh.refreshTodo(instance, generation, signal);
    }

    async refreshArtifacts(generation = this.#generation): Promise<void> {
        await this.#refresh.refreshArtifacts(generation);
    }

    async refreshLogs(generation = this.#generation): Promise<void> {
        await this.#refresh.refreshLogs(generation);
    }

    async refreshInstance(instance: string, generation = this.#generation): Promise<void> {
        const fromSeq = await this.#refresh.refreshInstance(instance, generation);
        if (!this.#current(generation)) return;
        this.#subscriptions.subscribeInstance(instance, fromSeq);
    }

    async refresh(generation = this.#generation): Promise<void> {
        if (!this.#current(generation)) return;
        this.#store.setConnectionState("connecting");
        try {
            await this.#clients.service.ping();
            if (!this.#current(generation)) return;
            const subscriptions = await this.#refresh.refreshAll(generation);
            if (!this.#current(generation)) return;
            this.#subscriptions.replaceAll(subscriptions);
            this.#store.setConnectionState("connected");
        } catch (error) {
            if (this.#current(generation)) this.#applyConnectionFailure(error);
        }
    }

    async #recoverInstanceSubscription(instance: string): Promise<void> {
        if (!this.#started) {
            return;
        }
        try {
            await this.refreshInstance(instance);
        } catch (error) {
            this.#applyConnectionFailure(error);
        }
    }

    #handleInstanceEvent(
        message: Extract<
            TuiClientRuntimeStreamMessage,
            { kind: "instance.event" }
        >
    ): void {
        const generation = this.#generation;
        if (!this.#current(generation)) {
            return;
        }
        const instance = message.event.destination;
        if (!isTuiPresentationEvent(message.event.name)) {
            return;
        }
        this.#store.applyEvent(message.event);
        if (
            this.#store.getState().ui.selectedPage === "overview" &&
            isOverviewRefreshEvent(message.event.name)
        ) {
            this.#scheduleOverviewRefresh(generation);
        }
        if (message.event.name.startsWith("todo.")) {
            this.#runBackgroundRefresh("todo", generation, async () => await this.#refresh.refreshTodo(instance, generation));
        }
        if (isTerminalToolCallEvent(message.event.name)) {
            this.#scheduleAuditRefresh(instance, generation);
        }
        const state = this.#store.getState();
        if (
            message.event.name === "log.appended" &&
            state.ui.selectedPage === "logs" &&
            state.ui.selectedInstance === instance &&
            state.ui.logsFollowByInstance[instance] !== false
        ) {
            this.#store.setScrollOffset(
                selectMainScrollKey(state),
                Number.MAX_SAFE_INTEGER
            );
        }
    }

    async #handleSubscribeError(
        instance: string,
        error: unknown
    ): Promise<void> {
        if (!this.#started) {
            return;
        }
        if (readTuiControlErrorCode(error) === "stream.gap") {
            await this.#recoverInstanceSubscription(instance);
            return;
        }
        this.#applyConnectionFailure(error);
    }

    #handleDisconnected(): void {
        this.#generation += 1;
        this.#stopOAuthRefresh();
        this.#stopOverviewPolling();
        this.#stopOverviewRefresh();
        this.#stopAuditRefreshes();
        this.#store.setConnectionState("disconnected");
        this.#subscriptions.closeAll();
    }

    #applyConnectionFailure(error: unknown): void {
        this.#generation += 1;
        const failure = toFailure(error);
        this.#store.setConnectionState(failure.status, failure.error);
        this.#stopOAuthRefresh();
        this.#stopOverviewPolling();
        this.#stopOverviewRefresh();
        this.#stopAuditRefreshes();
        this.#subscriptions.closeAll();
    }

    #startOAuthRefresh(): void {
        if (this.#oauthRefreshTimer !== undefined || !this.#refresh.oauthApprovalsAvailable()) {
            return;
        }
        this.#oauthRefreshTimer = setInterval(() => {
            const generation = this.#generation;
            this.#runBackgroundRefresh("connections", generation, async () => await this.#refresh.refreshOAuth(generation));
        }, 1_000);
    }

    #stopOAuthRefresh(): void {
        if (this.#oauthRefreshTimer === undefined) {
            return;
        }
        clearInterval(this.#oauthRefreshTimer);
        this.#oauthRefreshTimer = undefined;
    }

    #startOverviewPolling(): void {
        if (
            this.#overviewPollTimer !== undefined ||
            this.#overviewRefreshIntervalMs <= 0
        ) {
            return;
        }
        this.#overviewPollTimer = setInterval(() => {
            if (
                !this.#started ||
                this.#store.getState().connection.status !== "connected" ||
                this.#store.getState().ui.selectedPage !== "overview"
            ) {
                return;
            }
            const generation = this.#generation;
            void this.#refreshVisibleOverview(generation);
        }, this.#overviewRefreshIntervalMs);
    }

    #stopOverviewPolling(): void {
        if (this.#overviewPollTimer === undefined) {
            return;
        }
        clearInterval(this.#overviewPollTimer);
        this.#overviewPollTimer = undefined;
    }

    #scheduleOverviewRefresh(generation: number): void {
        this.#stopOverviewRefresh();
        this.#overviewRefreshTimer = setTimeout(() => {
            this.#overviewRefreshTimer = undefined;
            if (!this.#started || this.#store.getState().ui.selectedPage !== "overview") {
                return;
            }
            if (!this.#current(generation)) return;
            void this.#refreshVisibleOverview(generation);
        }, 75);
    }

    async #refreshVisibleOverview(generation = this.#generation): Promise<void> {
        try {
            await this.#requestOverviewRefresh(generation);
            if (!this.#current(generation)) return;
            this.#clearRefreshFailure("overview");
        } catch (error) {
            if (!this.#current(generation)) return;
            this.#reportRefreshFailure("overview", error);
        }
    }

    async #requestOverviewRefresh(generation = this.#generation): Promise<void> {
        if (this.#overviewRefreshRequest !== undefined && this.#overviewRefreshGeneration === generation) {
            return await this.#overviewRefreshRequest;
        }
        const request = this.#refresh.refreshOverview(generation);
        this.#overviewRefreshGeneration = generation;
        this.#overviewRefreshRequest = request;
        try {
            await request;
        } finally {
            if (this.#overviewRefreshRequest === request && this.#overviewRefreshGeneration === generation) {
                this.#overviewRefreshRequest = undefined;
                this.#overviewRefreshGeneration = undefined;
            }
        }
    }

    #stopOverviewRefresh(): void {
        if (this.#overviewRefreshTimer === undefined) {
            return;
        }
        clearTimeout(this.#overviewRefreshTimer);
        this.#overviewRefreshTimer = undefined;
    }

    #scheduleAuditRefresh(instance: string, generation: number): void {
        const state = this.#store.getState();
        if (state.ui.selectedPage !== "audit" || state.ui.selectedInstance !== instance) {
            return;
        }
        const current = this.#auditRefreshTimers.get(instance);
        if (current !== undefined) {
            clearTimeout(current);
        }
        this.#auditRefreshTimers.set(instance, setTimeout(() => {
            this.#auditRefreshTimers.delete(instance);
            if (!this.#started) {
                return;
            }
            const latest = this.#store.getState();
            if (latest.ui.selectedPage === "audit" && latest.ui.selectedInstance === instance) {
                this.#runBackgroundRefresh("audit", generation, async () => await this.#refresh.refreshAudit(instance, generation));
            }
        }, 50));
    }

    #stopAuditRefreshes(): void {
        for (const timer of this.#auditRefreshTimers.values()) {
            clearTimeout(timer);
        }
        this.#auditRefreshTimers.clear();
    }

    #runBackgroundRefresh(
        page: "audit" | "connections" | "todo",
        generation: number,
        refresh: () => Promise<void>
    ): void {
        void refresh().then(
            () => {
                if (this.#current(generation)) this.#clearRefreshFailure(page);
            },
            (error: unknown) => {
                if (this.#current(generation)) this.#reportRefreshFailure(page, error);
            }
        );
    }

    #clearRefreshFailure(page: "audit" | "connections" | "overview" | "todo"): void {
        if (!this.#started) {
            return;
        }
        const status = this.#store.getState().interaction.screenStatusByPage[page];
        if (status?.startsWith(`${refreshPageLabel(page)} refresh failed:`) === true) {
            this.#store.setScreenStatus(page, undefined);
        }
    }

    #reportRefreshFailure(
        page: "audit" | "connections" | "overview" | "todo",
        error: unknown
    ): void {
        if (!this.#started) {
            return;
        }
        this.#store.setScreenStatus(
            page,
            `${refreshPageLabel(page)} refresh failed: ${readErrorMessage(error)}`
        );
    }

    #current(generation: number): boolean {
        return this.#started && this.#generation === generation;
    }
}

function refreshPageLabel(page: "audit" | "connections" | "overview" | "todo"): string {
    return page[0]!.toUpperCase() + page.slice(1);
}

function isTuiPresentationEvent(name: string): boolean {
    return isInstanceHealthEvent(name) ||
        name === "log.appended" ||
        name.startsWith("toolCall.") ||
        name.startsWith("approval.") ||
        name.startsWith("context.message.") ||
        name.startsWith("todo.") ||
        name.startsWith("artifact.share") ||
        name.startsWith("artifact.transfer");
}

function isTerminalToolCallEvent(name: string): boolean {
    return name === "toolCall.completed" ||
        name === "toolCall.failed" ||
        name === "toolCall.denied" ||
        name === "toolCall.expired" ||
        name === "toolCall.queueTimeout" ||
        name === "toolCall.cancelled";
}

function isOverviewRefreshEvent(name: string): boolean {
    return isInstanceHealthEvent(name) ||
        name.startsWith("toolCall.") ||
        name.startsWith("approval.") ||
        name.startsWith("context.message.") ||
        name.startsWith("todo.");
}

function isInstanceHealthEvent(name: string): boolean {
    return name === "instance.started" ||
        name === "instance.stopped" ||
        name === "instance.statusChanged" ||
        name === "instance.connectionChanged" ||
        name === "instance.readyChanged" ||
        name === "worker.rpcConnected" ||
        name === "worker.rpcDisconnected" ||
        name === "reverse.connected" ||
        name === "reverse.disconnected" ||
        name === "reverse.enrollmentChanged" ||
        name === "reverse.transportChanged";
}

function toFailure(error: unknown): {
    error: { code?: string; message?: string };
    status: "disconnected" | "error";
} {
    const code = readTuiControlErrorCode(error);
    const message = readErrorMessage(error);
    if (code === "control.notRunning") {
        return {
            error: { code, message },
            status: "disconnected"
        };
    }
    return {
        error: {
            ...(code === undefined ? {} : { code }),
            message
        },
        status: "error"
    };
}

function readErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
    ) {
        return error.message;
    }
    return String(error);
}
