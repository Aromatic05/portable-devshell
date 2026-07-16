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
    store?: TuiAppStore;
}

export class TuiControlSession {
    readonly #clients: TuiClients;
    readonly #refresh: TuiControlSessionRefresh;
    readonly #store: TuiAppStore;
    readonly #subscriptions: TuiControlSessionSubscriptions;
    #oauthRefreshTimer?: ReturnType<typeof setInterval>;
    #started = false;

    constructor(options: TuiControlSessionOptions = {}) {
        this.#clients = options.clients ?? createControlClients();
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
        }
    }

    async stop(): Promise<void> {
        this.#started = false;
        this.#stopOAuthRefresh();
        this.#subscriptions.closeAll();
        this.#clients.close();
    }

    async reconnect(): Promise<void> {
        if (!this.#started) {
            return;
        }
        this.#stopOAuthRefresh();
        try {
            await this.#clients.reconnect();
            await this.refresh();
            if (this.#store.getState().connection.status === "connected") {
                this.#startOAuthRefresh();
            }
        } catch (error) {
            this.#applyConnectionFailure(error);
        }
    }

    async refreshConfig(): Promise<void> {
        await this.#refresh.refreshConfig();
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
        this.#store.applyEvent(message.event);
        const instance = message.event.destination;
        if (message.event.name.startsWith("todo.")) {
            void this.#refresh.refreshTodo(instance).catch(() => undefined);
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
        this.#store.setConnectionState("disconnected");
        this.#subscriptions.closeAll();
    }

    #applyConnectionFailure(error: unknown): void {
        const failure = toFailure(error);
        this.#store.setConnectionState(failure.status, failure.error);
        this.#subscriptions.closeAll();
    }

    #startOAuthRefresh(): void {
        if (this.#oauthRefreshTimer !== undefined) {
            return;
        }
        this.#oauthRefreshTimer = setInterval(() => {
            void this.#refresh.refreshOAuth().catch(() => undefined);
        }, 1_000);
    }

    #stopOAuthRefresh(): void {
        if (this.#oauthRefreshTimer === undefined) {
            return;
        }
        clearInterval(this.#oauthRefreshTimer);
        this.#oauthRefreshTimer = undefined;
    }
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
