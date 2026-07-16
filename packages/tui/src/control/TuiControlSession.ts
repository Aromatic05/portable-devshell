import type {
    InstanceListEntry,
    InstanceLogEntry,
    InstanceRuntimeEnvelope,
    JsonValue
} from "@portable-devshell/shared";

import { createClients as createControlClients, type Clients } from "../client/ClientComposition.js";
import type { RuntimeStreamMessage } from "../modules/runtime/RuntimeStream.js";
import { TuiAppStore } from "../store/TuiAppStore.js";
import type { TuiInstanceListEntry, TuiLogEntry } from "../store/TuiReducers.js";

const LOG_READ_LIMIT = 100;

export interface TuiControlSessionOptions {
    clients?: Clients;
    store?: TuiAppStore;
}

export class TuiControlSession {
    readonly #clients: Clients;
    readonly #store: TuiAppStore;
    readonly #subscriptions = new Map<string, TuiInstanceSubscription>();
    #oauthRefreshTimer?: ReturnType<typeof setInterval>;
    #started = false;

    constructor(options: TuiControlSessionOptions = {}) {
        this.#clients = options.clients ?? createControlClients();
        this.#store = options.store ?? new TuiAppStore();
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
        this.#oauthRefreshTimer = setInterval(() => {
            void this.#reloadOAuthApprovals(this.#store.getState().configView).catch(() => undefined);
        }, 1_000);
    }

    async stop(): Promise<void> {
        this.#started = false;
        if (this.#oauthRefreshTimer !== undefined) {
            clearInterval(this.#oauthRefreshTimer);
            this.#oauthRefreshTimer = undefined;
        }
        this.#closeSubscriptions();
    }

    async reconnect(): Promise<void> {
        if (!this.#started) {
            return;
        }

        await this.refresh();
    }


    async refreshConfig(): Promise<void> {
        const configView = await this.#readConfigView();
        this.#store.setMcpStatus(await this.#clients.mcp.status());
        const runtimeInstances = await this.#clients.instance.list();
        this.#store.replaceInstances(mergeInstances(configView, runtimeInstances));
        this.#store.setConfigView(configView);
    }

    async refreshOAuth(): Promise<void> {
        await this.#reloadOAuthApprovals(this.#store.getState().configView);
    }

    async refreshAudit(instance: string): Promise<void> {
        await this.#reloadToolCalls(instance);
        await this.#reloadApprovals(instance);
    }

    async refreshLogsForInstance(instance: string): Promise<void> {
        await this.#reloadLogs(instance);
    }

    async refreshTodo(instance: string): Promise<void> {
        await this.#reloadTodo(instance);
    }

    async refreshArtifacts(): Promise<void> {
        try {
            const [shares, transfers] = await Promise.all([
                this.#clients.artifact.listShares(),
                this.#clients.artifact.listTransfers()
            ]);
            this.#store.replaceArtifactShares(shares);
            this.#store.replaceArtifactTransfers(transfers);
        } catch (error) {
            if (readErrorCode(error) !== "control.methodNotFound") {
                throw error;
            }
            this.#store.replaceArtifactShares([]);
            this.#store.replaceArtifactTransfers([]);
        }
    }

    async refreshLogs(): Promise<void> {
        const instances = this.#readRuntimeInstances();

        for (const instance of instances) {
            await this.#reloadLogs(instance);
        }
    }

    async refreshInstance(instance: string): Promise<void> {
        await this.#reloadRuntimeInstance(instance);
    }

    async refresh(): Promise<void> {
        this.#store.setConnectionState("connecting");

        try {
            await this.#clients.service.ping();
            const configView = await this.#readConfigView();
            const runtimeInstances = await this.#clients.instance.list();
            this.#store.setMcpStatus(await this.#clients.mcp.status());
            this.#store.replaceInstances(mergeInstances(configView, runtimeInstances));
            this.#store.setConfigView(configView);
            await this.#reloadOAuthApprovals(configView);
            await this.refreshArtifacts();
            await this.#reloadAllInstances(runtimeInstances);
            this.#store.setConnectionState("connected");
        } catch (error) {
            const failure = toFailure(error);
            this.#store.setConnectionState(failure.status, failure.error);
            this.#closeSubscriptions();
        }
    }

    async #reloadAllInstances(instances: InstanceListEntry[]): Promise<void> {
        this.#closeSubscriptions();

        for (const instance of instances) {
            await this.#reloadRuntimeInstance(instance.name);
        }
    }

    async #reloadInstance(instance: string): Promise<void> {
        await this.#reloadRuntimeInstance(instance);
    }

    async #reloadRuntimeInstance(instance: string): Promise<void> {
        const snapshotEnvelope = await this.#clients.runtime.snapshot(instance);
        this.#store.replaceSnapshot(snapshotEnvelope.snapshot);
        await this.#reloadTodo(instance);
        await this.#reloadLogs(instance);
        await this.#reloadToolCalls(instance);
        await this.#reloadApprovals(instance);
        this.#subscribeInstance(instance, nextSubscribeSeq(snapshotEnvelope));
    }

    async #reloadTodo(instance: string): Promise<void> {
        const envelope = await this.#clients.todo.get(instance);
        this.#store.replaceTodo(instance, envelope.todo);
    }

    async #reloadLogs(instance: string): Promise<void> {
        const logs = await this.#clients.runtime.readLogs(instance, { limit: LOG_READ_LIMIT });
        this.#store.replaceLogs(instance, logs.map(mapLogEntry));
    }

    async #reloadToolCalls(instance: string): Promise<void> {
        this.#store.replaceToolCalls(instance, await this.#clients.tool.listCalls(instance, { limit: 100 }));
    }

    async #reloadApprovals(instance: string): Promise<void> {
        this.#store.replaceApprovals(instance, await this.#clients.tool.listApprovals(instance));
    }

    async #reloadOAuthApprovals(configView: Record<string, JsonValue> | undefined): Promise<void> {
        if (oauthApprovalsUnavailable(configView)) {
            this.#store.replaceOAuthApprovals([]);
            return;
        }

        this.#store.replaceOAuthApprovals(await this.#clients.mcp.listApprovals());
    }

    #readRuntimeInstances(): string[] {
        return this.#store
            .getState()
            .instances.filter((instance) => this.#store.getState().snapshotsByInstance[instance.name] !== undefined)
            .map((instance) => instance.name);
    }

    async #readConfigView(): Promise<Record<string, JsonValue> | undefined> {
        try {
            return await this.#clients.config.get();
        } catch (error) {
            if (readErrorCode(error) === "control.methodNotFound") {
                return undefined;
            }

            throw error;
        }
    }

    #subscribeInstance(instance: string, fromSeq: number): void {
        this.#subscriptions.get(instance)?.close();
        const subscription = new TuiInstanceSubscription({
            instance,
            onConnectionClosed: () => {
                this.#handleDisconnected();
            },
            onGap: async () => {
                if (!this.#started) {
                    return;
                }

                await this.#reloadInstance(instance);
            },
            onInstanceEvent: (message) => {
                this.#store.applyEvent(message.event);
                if (message.event.name.startsWith("todo.")) {
                    void this.#reloadTodo(instance).catch(() => undefined);
                }
                const state = this.#store.getState();
                if (message.event.name === "log.appended" && state.ui.selectedPage === "logs" && state.ui.selectedInstance === instance && state.ui.logsFollowByInstance[instance] !== false) {
                    this.#store.setScrollOffset(`logs:${instance}:main`, Number.MAX_SAFE_INTEGER);
                }
            },
            onSubscribeError: async (error) => {
                if (!this.#started) {
                    return;
                }

                if (readErrorCode(error) === "stream.gap") {
                    await this.#reloadInstance(instance);
                    return;
                }

                const failure = toFailure(error);
                this.#store.setConnectionState(failure.status, failure.error);
                this.#closeSubscriptions();
            },
            subscribe: async (requestedFromSeq) => await this.#clients.runtime.subscribe(instance, requestedFromSeq)
        });

        this.#subscriptions.set(instance, subscription);
        void subscription.start(fromSeq);
    }

    #closeSubscriptions(): void {
        for (const subscription of this.#subscriptions.values()) {
            subscription.close();
        }

        this.#subscriptions.clear();
    }

    #handleDisconnected(): void {
        this.#store.setConnectionState("disconnected");
        this.#closeSubscriptions();
    }
}

function oauthApprovalsUnavailable(configView: Record<string, JsonValue> | undefined): boolean {
    const mcp = configView?.mcp;
    if (typeof mcp !== "object" || mcp === null || Array.isArray(mcp)) {
        return true;
    }

    const auth = mcp.auth;
    return typeof auth !== "object" || auth === null || Array.isArray(auth) || auth.mode !== "oauth2";
}

interface TuiInstanceSubscriptionOptions {
    instance: string;
    onConnectionClosed(): void;
    onGap(): Promise<void>;
    onInstanceEvent(message: Extract<RuntimeStreamMessage, { kind: "instance.event" }>): void;
    onSubscribeError(error: unknown): Promise<void>;
    subscribe(fromSeq: number): Promise<{ close(): void; nextMessage(): Promise<RuntimeStreamMessage> }>;
}

class TuiInstanceSubscription {
    readonly #instance: string;
    readonly #onConnectionClosed: () => void;
    readonly #onGap: () => Promise<void>;
    readonly #onInstanceEvent: (message: Extract<RuntimeStreamMessage, { kind: "instance.event" }>) => void;
    readonly #onSubscribeError: (error: unknown) => Promise<void>;
    readonly #subscribe: TuiInstanceSubscriptionOptions["subscribe"];
    #closed = false;
    #stream?: { close(): void; nextMessage(): Promise<RuntimeStreamMessage> };

    constructor(options: TuiInstanceSubscriptionOptions) {
        this.#instance = options.instance;
        this.#onConnectionClosed = options.onConnectionClosed;
        this.#onGap = options.onGap;
        this.#onInstanceEvent = options.onInstanceEvent;
        this.#onSubscribeError = options.onSubscribeError;
        this.#subscribe = options.subscribe;
    }

    async start(fromSeq: number): Promise<void> {
        try {
            this.#stream = await this.#subscribe(fromSeq);

            while (!this.#closed) {
                const message = await this.#stream.nextMessage();

                if (this.#closed) {
                    return;
                }

                switch (message.kind) {
                    case "instance.event":
                        if (message.event.destination === this.#instance) {
                            this.#onInstanceEvent(message);
                        }
                        break;
                    case "stream.gap":
                        this.close();
                        await this.#onGap();
                        return;
                    case "stream.cancelled":
                        this.close();
                        this.#onConnectionClosed();
                        return;
                    case "connection.closed":
                        this.close();
                        this.#onConnectionClosed();
                        return;
                }
            }
        } catch (error) {
            if (this.#closed) {
                return;
            }

            this.close();
            await this.#onSubscribeError(error);
        }
    }

    close(): void {
        if (this.#closed) {
            return;
        }

        this.#closed = true;
        this.#stream?.close();
    }
}

function nextSubscribeSeq(snapshotEnvelope: InstanceRuntimeEnvelope): number {
    return Math.max(snapshotEnvelope.lastSeq, 1);
}

function mergeInstances(
    configView: Record<string, JsonValue> | undefined,
    runtimeInstances: InstanceListEntry[]
): TuiInstanceListEntry[] {
    const runtimeByName = new Map(runtimeInstances.map((instance) => [instance.name, instance] as const));
    const configured = readConfigInstances(configView);
    const merged = new Map<string, TuiInstanceListEntry>();

    for (const instance of configured) {
        const runtime = runtimeByName.get(instance.name);
        merged.set(instance.name, {
            defaultWorkspace: instance.defaultWorkspace,
            enabled: instance.enabled,
            mcpEnabled: runtime?.mcpEnabled ?? instance.mcpEnabled,
            mcpPath: instance.mcpPath,
            name: instance.name,
            provider: instance.provider
        });
    }

    for (const runtime of runtimeInstances) {
        if (merged.has(runtime.name)) {
            continue;
        }

        merged.set(runtime.name, {
            enabled: true,
            mcpEnabled: runtime.mcpEnabled,
            name: runtime.name
        });
    }

    return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function readConfigInstances(configView: Record<string, JsonValue> | undefined): TuiInstanceListEntry[] {
    const value = configView?.instances;

    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry) || typeof entry.name !== "string") {
            return [];
        }

        const mcp = typeof entry.mcp === "object" && entry.mcp !== null && !Array.isArray(entry.mcp) ? entry.mcp : undefined;
        return [
            {
                defaultWorkspace: typeof entry.workspace === "string" ? entry.workspace : undefined,
                enabled: entry.enabled !== false,
                mcpEnabled: mcp?.enabled === true,
                mcpPath: typeof mcp?.path === "string" ? mcp.path : undefined,
                name: entry.name,
                provider: typeof entry.provider === "string" ? entry.provider : undefined
            }
        ];
    });
}

function mapLogEntry(entry: InstanceLogEntry): TuiLogEntry {
    return {
        at: entry.at,
        bytes: Buffer.byteLength(entry.message, "utf8"),
        callId: entry.callId,
        instance: entry.instanceName,
        message: entry.message,
        requestId: entry.requestId,
        preview: entry.message.slice(0, 160),
        receivedAt: entry.at,
        seq: entry.seq,
        ctxId: entry.ctxId,
        source: entry.source,
        stream: entry.stream,
        tail: entry.message.slice(-160),
        toolName: entry.toolName
    };
}

function readErrorCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null || !("code" in error)) {
        return undefined;
    }

    return typeof error.code === "string" ? error.code : undefined;
}

function toFailure(error: unknown): {
    error: { code?: string; message?: string };
    status: "disconnected" | "error";
} {
    const code = readErrorCode(error);
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

    if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
        return error.message;
    }

    return String(error);
}
