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
    #overviewRefreshTimer?: ReturnType<typeof setTimeout>;
    #started = false;

    constructor(options: TuiControlSessionOptions = {}) {
        this.#clients = options.clients ?? createControlClients();
        this.#overviewRefreshIntervalMs = options.overviewRefreshIntervalMs ?? 5_000;
        this.#store = options.store ?? new TuiAppStore();
        this.#refresh = new TuiControlSessionRefresh({
            clients: this.#clients,
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
        await this.refresh();
        if (this.#store.getState().connection.status === "connected") {
            this.#startOAuthRefresh();
            this.#startOverviewPolling();
        }
    }

    async stop(): Promise<void> {
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
        this.#stopOAuthRefresh();
        this.#stopOverviewPolling();
        try {
            await this.#clients.reconnect();
            await this.refresh();
            if (this.#store.getState().connection.status === "connected") {
                this.#startOAuthRefresh();
                this.#startOverviewPolling();
            }
        } catch (error) {
            this.#applyConnectionFailure(error);
        }
    }

    async refreshConfig(): Promise<void> {
        await this.#refresh.refreshConfig();
        if (this.#store.getState().connection.status === "connected") {
            this.#stopOAuthRefresh();
            this.#startOAuthRefresh();
        }
    }

    async refreshOverview(): Promise<void> {
        await this.#requestOverviewRefresh();
    }

    async refreshOAuth(): Promise<void> {
        await this.#refresh.refreshOAuth();
    }

    async refreshAudit(instance: string): Promise<void> {
        await this.#refresh.refreshAudit(instance);
    }

    async refreshLogsForInstance(instance: string): Promise<void> {
        await this.#refresh.refreshLogsForInstance(instance);
    }

    async refreshTodo(instance: string): Promise<void> {
        await this.#refresh.refreshTodo(instance);
    }

    async refreshArtifacts(): Promise<void> {
        await this.#refresh.refreshArtifacts();
    }

    async refreshLogs(): Promise<void> {
        await this.#refresh.refreshLogs();
    }

    async refreshInstance(instance: string): Promise<void> {
        const fromSeq = await this.#refresh.refreshInstance(instance);
        this.#subscriptions.subscribeInstance(instance, fromSeq);
    }

    async refresh(): Promise<void> {
        this.#store.setConnectionState("connecting");
        try {
            await this.#clients.service.ping();
            const subscriptions = await this.#refresh.refreshAll();
            this.#subscriptions.replaceAll(subscriptions);
            this.#store.setConnectionState("connected");
        } catch (error) {
            this.#applyConnectionFailure(error);
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
        const instance = message.event.destination;
        if (!isTuiPresentationEvent(message.event.name)) {
            return;
        }
        this.#store.applyEvent(message.event);
        if (
            this.#store.getState().ui.selectedPage === "overview" &&
            isOverviewRefreshEvent(message.event.name)
        ) {
            this.#scheduleOverviewRefresh();
        }
        if (message.event.name.startsWith("todo.")) {
            void this.#refresh.refreshTodo(instance).catch((error: unknown) => {
                this.#reportRefreshFailure("todo", error);
            });
        }
        if (isTerminalToolCallEvent(message.event.name)) {
            this.#scheduleAuditRefresh(instance);
        }
        const state = this.#store.getState();
        if (
            message.event.name === "log.appended" &&
            state.ui.selectedPage === "logs" &&
            state.ui.selectedInstance === instance &&
            state.ui.logsFollowByInstance[instance] !== false
        ) {
            this.#store.setScrollOffset(
                `logs:${instance}:main`,
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
        this.#stopOAuthRefresh();
        this.#stopOverviewPolling();
        this.#stopOverviewRefresh();
        this.#stopAuditRefreshes();
        this.#store.setConnectionState("disconnected");
        this.#subscriptions.closeAll();
    }

    #applyConnectionFailure(error: unknown): void {
        const failure = toFailure(error);
        this.#store.setConnectionState(failure.status, failure.error);
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
            void this.#refresh.refreshOAuth().catch((error: unknown) => {
                this.#reportRefreshFailure("oauth", error);
            });
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
            void this.#refreshVisibleOverview();
        }, this.#overviewRefreshIntervalMs);
    }

    #stopOverviewPolling(): void {
        if (this.#overviewPollTimer === undefined) {
            return;
        }
        clearInterval(this.#overviewPollTimer);
        this.#overviewPollTimer = undefined;
    }

    #scheduleOverviewRefresh(): void {
        this.#stopOverviewRefresh();
        this.#overviewRefreshTimer = setTimeout(() => {
            this.#overviewRefreshTimer = undefined;
            if (!this.#started || this.#store.getState().ui.selectedPage !== "overview") {
                return;
            }
            void this.#refreshVisibleOverview();
        }, 75);
    }

    async #refreshVisibleOverview(): Promise<void> {
        try {
            await this.#requestOverviewRefresh();
        } catch (error) {
            this.#store.setScreenStatus(
                "overview",
                `Overview refresh failed: ${readErrorMessage(error)}`
            );
        }
    }

    async #requestOverviewRefresh(): Promise<void> {
        if (this.#overviewRefreshRequest !== undefined) {
            return await this.#overviewRefreshRequest;
        }
        const request = this.#refresh.refreshOverview();
        this.#overviewRefreshRequest = request;
        try {
            await request;
        } finally {
            if (this.#overviewRefreshRequest === request) {
                this.#overviewRefreshRequest = undefined;
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

    #scheduleAuditRefresh(instance: string): void {
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
                void this.#refresh.refreshAudit(instance).catch((error: unknown) => {
                    this.#reportRefreshFailure("audit", error);
                });
            }
        }, 50));
    }

    #stopAuditRefreshes(): void {
        for (const timer of this.#auditRefreshTimers.values()) {
            clearTimeout(timer);
        }
        this.#auditRefreshTimers.clear();
    }

    #reportRefreshFailure(page: "audit" | "oauth" | "todo", error: unknown): void {
        if (!this.#started) {
            return;
        }
        this.#store.setScreenStatus(
            page,
            `${page === "oauth" ? "OAuth" : page[0]!.toUpperCase() + page.slice(1)} refresh failed: ${readErrorMessage(error)}`
        );
    }
}

function isTuiPresentationEvent(name: string): boolean {
    return isInstanceHealthEvent(name) ||
        name === "log.appended" ||
        name.startsWith("toolCall.") ||
        name.startsWith("approval.") ||
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
