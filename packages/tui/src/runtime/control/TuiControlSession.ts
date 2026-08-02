import { createError, errorCodes, type InstanceSnapshot } from "@portable-devshell/shared";
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
import { withTuiRequestTimeout } from "./TuiRequestTimeout.js";
import { selectMainScrollKey } from "../../view/model/TuiViewProjection.js";

export interface TuiControlSessionOptions {
    clients?: TuiClients;
    overviewRefreshIntervalMs?: number;
    readTimeoutMs?: number;
    store?: TuiAppStore;
    subscriptionRetryBaseMs?: number;
    subscriptionStableAfterMs?: number;
}

export class TuiControlSession {
    readonly #clients: TuiClients;
    readonly #refresh: TuiControlSessionRefresh;
    readonly #overviewRefreshIntervalMs: number;
    readonly #readTimeoutMs: number;
    readonly #store: TuiAppStore;
    readonly #subscriptions: TuiControlSessionSubscriptions;
    readonly #auditRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
    #oauthRefreshGeneration?: number;
    #oauthRefreshRequest?: Promise<void>;
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
        this.#readTimeoutMs = options.readTimeoutMs ?? 10_000;
        this.#store = options.store ?? new TuiAppStore();
        this.#refresh = new TuiControlSessionRefresh({
            clients: this.#clients,
            isCurrent: (generation) => this.#current(generation),
            readTimeoutMs: options.readTimeoutMs,
            store: this.#store
        });
        this.#subscriptions = new TuiControlSessionSubscriptions({
            currentSequence: (instance) => Math.max(
                1,
                this.#store.getState().lastSeqByInstance[instance] ?? 1
            ),
            onConnectionClosed: () => {
                this.#handleDisconnected();
            },
            onEvent: (message) => {
                this.#handleInstanceEvent(message);
            },
            onGap: async (instance) => {
                return await this.#recoverInstanceSubscription(instance);
            },
            onRecovered: (instance) => {
                this.#store.setPanelError(`instances:${instance}:subscription`, undefined);
            },
            onSubscribeError: async (instance, error) => {
                await this.#handleSubscribeError(instance, error);
            },
            retryBaseMs: options.subscriptionRetryBaseMs,
            subscribeTimeoutMs: this.#readTimeoutMs,
            stableAfterMs: options.subscriptionStableAfterMs,
            subscribe: async (instance, fromSeq) => {
                return await this.#clients.runtime.subscribe(instance, fromSeq);
            }
        });
    }

    get store(): TuiAppStore {
        return this.#store;
    }

    applyAuthoritativeSnapshot(snapshot: InstanceSnapshot): void {
        this.#refresh.applyAuthoritativeSnapshot(snapshot);
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
            await withTuiRequestTimeout(this.#clients.reconnect(), this.#readTimeoutMs, "control.reconnect");
            this.#assertCurrent(generation, "Control connection changed while reconnecting.");
            await this.#refreshConnected(generation);
            this.#assertCurrent(generation, "Control connection changed while refreshing after reconnect.");
            if (this.#store.getState().connection.status !== "connected") {
                throw new Error("Control reconnect completed without a connected session.");
            }
            this.#startOAuthRefresh();
            this.#startOverviewPolling();
        } catch (error) {
            if (this.#current(generation)) this.#applyConnectionFailure(error);
            throw error;
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
        if (signal?.aborted !== true) await this.#requestOAuthRefresh(generation);
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

    async refreshInstance(instance: string, generation = this.#generation): Promise<number | undefined> {
        const fromSeq = await this.#refresh.refreshInstance(instance, generation);
        if (!this.#current(generation) || fromSeq === undefined) return undefined;
        this.#subscriptions.subscribeInstance(instance, fromSeq);
        return fromSeq;
    }

    async refresh(generation?: number): Promise<void> {
        const activeGeneration = generation ?? ++this.#generation;
        if (!this.#current(activeGeneration)) return;
        try {
            await this.#refreshConnected(activeGeneration);
        } catch (error) {
            if (this.#current(activeGeneration)) this.#applyConnectionFailure(error);
        }
    }

    async #refreshConnected(activeGeneration: number): Promise<void> {
        this.#assertCurrent(activeGeneration, "Control connection changed before refresh.");
        this.#store.setConnectionState("connecting");
        await withTuiRequestTimeout(
            this.#clients.service.ping(),
            this.#readTimeoutMs,
            "service.ping"
        );
        this.#assertCurrent(activeGeneration, "Control connection changed during ping.");
        const subscriptions = await this.#refresh.refreshAll(activeGeneration);
        this.#assertCurrent(activeGeneration, "Control connection changed during refresh.");
        this.#subscriptions.replaceAll(subscriptions);
        this.#store.setConnectionState("connected");
    }

    #assertCurrent(generation: number, message: string): void {
        if (!this.#current(generation)) {
            throw new Error(message);
        }
    }

    async #recoverInstanceSubscription(instance: string): Promise<number | undefined> {
        if (!this.#started) return undefined;
        const generation = this.#generation;
        try {
            const fromSeq = await this.#refresh.refreshInstance(instance, generation);
            return this.#current(generation) ? fromSeq : undefined;
        } catch (error) {
            await this.#handleSubscribeError(instance, error);
            return undefined;
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
        if (!this.#started) return;
        this.#store.setPanelError(`instances:${instance}:subscription`, toPanelError(error));
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
            this.#runBackgroundRefresh("connections", generation, async () => await this.#requestOAuthRefresh(generation));
        }, 1_000);
    }

    async #requestOAuthRefresh(generation = this.#generation): Promise<void> {
        if (
            this.#oauthRefreshRequest !== undefined &&
            this.#oauthRefreshGeneration === generation
        ) {
            return await this.#oauthRefreshRequest;
        }
        const request = this.#refresh.refreshOAuth(generation);
        this.#oauthRefreshGeneration = generation;
        this.#oauthRefreshRequest = request;
        try {
            await request;
        } finally {
            if (
                this.#oauthRefreshRequest === request &&
                this.#oauthRefreshGeneration === generation
            ) {
                this.#oauthRefreshRequest = undefined;
                this.#oauthRefreshGeneration = undefined;
            }
        }
    }

    #stopOAuthRefresh(): void {
        if (this.#oauthRefreshTimer !== undefined) {
            clearInterval(this.#oauthRefreshTimer);
            this.#oauthRefreshTimer = undefined;
        }
        this.#oauthRefreshRequest = undefined;
        this.#oauthRefreshGeneration = undefined;
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

function toPanelError(error: unknown) {
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown } | undefined;
    return createError({
        code: typeof candidate?.code === "string" ? candidate.code : errorCodes.targetInvalid,
        message: typeof candidate?.message === "string" ? candidate.message : String(error),
        retryable: candidate?.retryable === true
    });
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
