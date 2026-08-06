import {
    ControlReadModel,
    createError,
    errorCodes,
    type ControlReadModelState,
    type InstanceEvent,
    type InstanceListEntry,
    type InstanceLogEntry,
    type InstanceSnapshot,
    type JsonValue,
} from "@portable-devshell/shared";
import {
    createTuiClients as createControlClients,
    type TuiClients,
} from "../client/TuiClientComposition.js";
import { TuiAppStore } from "../../state/TuiAppStore.js";
import type {
    TuiInstanceListEntry,
    TuiLogEntry,
} from "../../state/reducer/TuiStoreModel.js";
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
    readonly #model: ControlReadModel;
    readonly #overviewRefreshIntervalMs: number;
    readonly #readTimeoutMs: number;
    readonly #store: TuiAppStore;
    readonly #appliedPanelFailures = new Set<string>();
    #oauthRefreshRequest?: Promise<void>;
    #oauthRefreshTimer?: ReturnType<typeof setInterval>;
    #overviewPollTimer?: ReturnType<typeof setInterval>;
    #overviewRefreshRequest?: Promise<void>;
    #overviewRefreshTimer?: ReturnType<typeof setTimeout>;
    #started = false;
    #generation = 0;

    constructor(options: TuiControlSessionOptions = {}) {
        this.#clients = options.clients ?? createControlClients();
        this.#overviewRefreshIntervalMs = options.overviewRefreshIntervalMs ?? 5_000;
        this.#readTimeoutMs = options.readTimeoutMs ?? 10_000;
        this.#store = options.store ?? new TuiAppStore();
        this.#model = new ControlReadModel({
            clients: this.#clients,
            onConnectionClosed: () => this.#handleDisconnected(),
            onEvent: (event) => this.#handleInstanceEvent(event),
            requestTimeoutMs: this.#readTimeoutMs,
            retryBaseMs: options.subscriptionRetryBaseMs,
            scheduleDelayMs: 50,
            stableAfterMs: options.subscriptionStableAfterMs,
        });
        this.#model.subscribe(() => this.#syncModel());
    }

    get store(): TuiAppStore {
        return this.#store;
    }

    applyAuthoritativeSnapshot(snapshot: InstanceSnapshot): void {
        this.#model.applyAuthoritativeSnapshot(snapshot);
    }

    async start(): Promise<void> {
        if (this.#started) return;
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
        this.#stopBackgroundRefresh();
        this.#model.close();
        this.#clients.close();
    }

    async reconnect(): Promise<void> {
        if (!this.#started) return;
        const generation = ++this.#generation;
        this.#stopBackgroundRefresh();
        this.#model.reset();
        try {
            await withTuiRequestTimeout(
                this.#clients.reconnect(),
                this.#readTimeoutMs,
                "control.reconnect",
            );
            this.#assertCurrent(generation, "Control connection changed while reconnecting.");
            await this.#load(generation);
            this.#assertCurrent(generation, "Control connection changed while refreshing after reconnect.");
            this.#startOAuthRefresh();
            this.#startOverviewPolling();
        } catch (error) {
            if (this.#current(generation)) this.#applyConnectionFailure(error);
            throw error;
        }
    }

    async refreshConfig(generation = this.#generation, signal?: AbortSignal): Promise<void> {
        if (!this.#canRefresh(generation, signal)) return;
        await this.#model.refreshControl();
        if (this.#canRefresh(generation, signal)) {
            this.#stopOAuthRefresh();
            this.#startOAuthRefresh();
        }
    }

    async refreshOverview(generation = this.#generation, signal?: AbortSignal): Promise<void> {
        if (this.#canRefresh(generation, signal)) await this.#requestOverviewRefresh();
    }

    async refreshOAuth(generation = this.#generation, signal?: AbortSignal): Promise<void> {
        if (this.#canRefresh(generation, signal)) await this.#requestOAuthRefresh();
    }

    async refreshAudit(
        instance: string,
        generation = this.#generation,
        signal?: AbortSignal,
    ): Promise<void> {
        if (!this.#canRefresh(generation, signal)) return;
        await this.#model.refreshInstance(
            instance,
            ["toolCalls", "approvals", "commentCalls", "contextMessages"],
        );
    }

    async refreshLogsForInstance(
        instance: string,
        generation = this.#generation,
        signal?: AbortSignal,
    ): Promise<void> {
        if (this.#canRefresh(generation, signal)) {
            await this.#model.refreshInstance(instance, ["logs"]);
        }
    }

    async refreshTodo(
        instance: string,
        generation = this.#generation,
        signal?: AbortSignal,
        title?: string,
    ): Promise<void> {
        if (this.#canRefresh(generation, signal)) {
            await this.#model.refreshInstance(instance, ["todo"], title);
        }
    }

    async refreshArtifacts(generation = this.#generation): Promise<void> {
        if (this.#current(generation)) await this.#model.refreshArtifacts();
    }

    async refreshLogs(generation = this.#generation): Promise<void> {
        if (this.#current(generation)) await this.#model.refreshAllInstanceLogs();
    }

    async refreshInstance(
        instance: string,
        generation = this.#generation,
    ): Promise<number | undefined> {
        if (!this.#current(generation)) return undefined;
        const sequence = await this.#model.refreshInstance(instance);
        if (sequence !== undefined) this.#model.ensureInstanceSubscription(instance);
        return sequence;
    }

    async refresh(generation?: number): Promise<void> {
        const activeGeneration = generation ?? ++this.#generation;
        if (!this.#current(activeGeneration)) return;
        try {
            await this.#load(activeGeneration);
        } catch (error) {
            if (this.#current(activeGeneration)) this.#applyConnectionFailure(error);
        }
    }

    async #load(generation: number): Promise<void> {
        this.#assertCurrent(generation, "Control connection changed before refresh.");
        this.#store.setConnectionState("connecting");
        await this.#model.load({
            artifacts: true,
            config: true,
            serviceStatus: false,
        });
        this.#assertCurrent(generation, "Control connection changed during refresh.");
        this.#store.setConnectionState("connected");
    }

    #syncModel(): void {
        const model = this.#model.state;
        this.#store.setMcpStatus(model.mcpStatus);
        this.#store.setConfigView(model.configView);
        this.#store.setControlRestartRequired(model.configView?.restartControlRequired === true);
        this.#store.replaceInstances(mergeInstances(model.configView, model.instances));
        this.#store.replaceOAuthApprovals(model.oauthApprovals);
        this.#store.replaceOperationalOverview(model.overview);
        this.#store.replaceArtifactShares(model.artifactShares);
        this.#store.replaceArtifactTransfers(model.artifactTransfers);
        for (const [name, instance] of Object.entries(model.instanceState)) {
            if (instance.snapshot !== undefined) this.#store.replaceSnapshot(instance.snapshot);
            this.#store.replaceLogs(name, instance.logs.map(mapLogEntry));
            this.#store.replaceApprovals(name, instance.approvals);
            this.#store.replaceToolCalls(name, instance.toolCalls);
            this.#store.replaceCommentCalls(name, instance.commentCalls);
            this.#store.replaceContextMessages(name, instance.contextMessages);
            if (instance.todo !== undefined) this.#store.replaceTodo(name, instance.todo);
        }
        this.#syncFailures(model);
    }

    #syncFailures(model: Readonly<ControlReadModelState>): void {
        const next = new Map<string, Error[]>();
        for (const [key, error] of Object.entries(model.failures)) {
            const panel = tuiFailurePanel(key);
            const errors = next.get(panel) ?? [];
            errors.push(error);
            next.set(panel, errors);
        }
        for (const panel of this.#appliedPanelFailures) {
            if (!next.has(panel)) this.#store.setPanelError(panel, undefined);
        }
        this.#appliedPanelFailures.clear();
        for (const [panel, errors] of next) {
            this.#appliedPanelFailures.add(panel);
            this.#store.setPanelError(
                panel,
                toPanelError(new Error(errors.map((error) => error.message).join("; "))),
            );
        }
    }

    #handleInstanceEvent(event: InstanceEvent): void {
        if (!this.#started || !isTuiPresentationEvent(event.type)) return;
        this.#store.applyInstanceEvent(event);
        if (
            this.#store.getState().ui.selectedPage === "overview" &&
            isOverviewRefreshEvent(event.type)
        ) this.#scheduleOverviewRefresh();
        const state = this.#store.getState();
        if (
            event.type === "log.appended" &&
            state.ui.selectedPage === "logs" &&
            state.ui.selectedInstance === event.instanceName &&
            state.ui.logsFollowByInstance[event.instanceName] !== false
        ) {
            this.#store.setScrollOffset(selectMainScrollKey(state), Number.MAX_SAFE_INTEGER);
        }
    }

    #handleDisconnected(): void {
        if (!this.#started) return;
        this.#generation += 1;
        this.#stopBackgroundRefresh();
        this.#store.setConnectionState("disconnected");
        this.#model.reset();
    }

    #applyConnectionFailure(error: unknown): void {
        this.#generation += 1;
        const failure = toFailure(error);
        this.#store.setConnectionState(failure.status, failure.error);
        this.#stopBackgroundRefresh();
        this.#model.reset();
    }

    #startOAuthRefresh(): void {
        const status = this.#model.state.mcpStatus;
        if (
            this.#oauthRefreshTimer !== undefined ||
            status?.authMode !== "oauth2" ||
            status.oauthReady !== true ||
            status.running !== true
        ) return;
        this.#oauthRefreshTimer = setInterval(() => {
            const generation = this.#generation;
            this.#runBackgroundRefresh(
                "connections",
                generation,
                async () => await this.#requestOAuthRefresh(),
            );
        }, 1_000);
    }

    async #requestOAuthRefresh(): Promise<void> {
        if (this.#oauthRefreshRequest !== undefined) return await this.#oauthRefreshRequest;
        const request = this.#model.refreshOAuth().finally(() => {
            if (this.#oauthRefreshRequest === request) this.#oauthRefreshRequest = undefined;
        });
        this.#oauthRefreshRequest = request;
        return await request;
    }

    #stopOAuthRefresh(): void {
        if (this.#oauthRefreshTimer !== undefined) clearInterval(this.#oauthRefreshTimer);
        this.#oauthRefreshTimer = undefined;
        this.#oauthRefreshRequest = undefined;
    }

    #startOverviewPolling(): void {
        if (this.#overviewPollTimer !== undefined || this.#overviewRefreshIntervalMs <= 0) return;
        this.#overviewPollTimer = setInterval(() => {
            if (
                this.#started &&
                this.#store.getState().connection.status === "connected" &&
                this.#store.getState().ui.selectedPage === "overview"
            ) void this.#refreshVisibleOverview();
        }, this.#overviewRefreshIntervalMs);
    }

    #scheduleOverviewRefresh(): void {
        if (this.#overviewRefreshTimer !== undefined) clearTimeout(this.#overviewRefreshTimer);
        this.#overviewRefreshTimer = setTimeout(() => {
            this.#overviewRefreshTimer = undefined;
            if (this.#started && this.#store.getState().ui.selectedPage === "overview") {
                void this.#refreshVisibleOverview();
            }
        }, 75);
    }

    async #requestOverviewRefresh(): Promise<void> {
        if (this.#overviewRefreshRequest !== undefined) return await this.#overviewRefreshRequest;
        const request = this.#model.refreshOverview().finally(() => {
            if (this.#overviewRefreshRequest === request) this.#overviewRefreshRequest = undefined;
        });
        this.#overviewRefreshRequest = request;
        return await request;
    }

    async #refreshVisibleOverview(): Promise<void> {
        const generation = this.#generation;
        try {
            await this.#requestOverviewRefresh();
            if (this.#current(generation)) this.#clearRefreshFailure("overview");
        } catch (error) {
            if (this.#current(generation)) this.#reportRefreshFailure("overview", error);
        }
    }

    #stopBackgroundRefresh(): void {
        this.#stopOAuthRefresh();
        if (this.#overviewPollTimer !== undefined) clearInterval(this.#overviewPollTimer);
        if (this.#overviewRefreshTimer !== undefined) clearTimeout(this.#overviewRefreshTimer);
        this.#overviewPollTimer = undefined;
        this.#overviewRefreshTimer = undefined;
        this.#overviewRefreshRequest = undefined;
    }

    #runBackgroundRefresh(
        page: "audit" | "connections" | "todo",
        generation: number,
        refresh: () => Promise<void>,
    ): void {
        void refresh().then(
            () => { if (this.#current(generation)) this.#clearRefreshFailure(page); },
            (error: unknown) => { if (this.#current(generation)) this.#reportRefreshFailure(page, error); },
        );
    }

    #clearRefreshFailure(page: "audit" | "connections" | "overview" | "todo"): void {
        const status = this.#store.getState().interaction.screenStatusByPage[page];
        if (status?.startsWith(`${refreshPageLabel(page)} refresh failed:`) === true) {
            this.#store.setScreenStatus(page, undefined);
        }
    }

    #reportRefreshFailure(
        page: "audit" | "connections" | "overview" | "todo",
        error: unknown,
    ): void {
        if (this.#started) {
            this.#store.setScreenStatus(
                page,
                `${refreshPageLabel(page)} refresh failed: ${readErrorMessage(error)}`,
            );
        }
    }

    #canRefresh(generation: number, signal?: AbortSignal): boolean {
        return signal?.aborted !== true && this.#current(generation);
    }

    #assertCurrent(generation: number, message: string): void {
        if (!this.#current(generation)) throw new Error(message);
    }

    #current(generation: number): boolean {
        return this.#started && this.#generation === generation;
    }
}

function tuiFailurePanel(key: string): string {
    const separator = key.indexOf(":");
    const kind = separator < 0 ? key : key.slice(0, separator);
    const instance = separator < 0 ? "-" : key.slice(separator + 1);
    if (kind === "snapshot") return `instances:${instance}:snapshot`;
    if (kind === "stream") return `instances:${instance}:subscription`;
    if (kind === "logs") return `logs:${instance}:logs`;
    if (kind === "todo") return `todo:${instance}:todo`;
    if (["approvals", "toolCalls", "commentCalls", "contextMessages"].includes(kind)) {
        return `audit:${instance}:readModels`;
    }
    if (kind === "overview") return "overview:-:overview";
    if (kind === "oauthApprovals" || kind === "mcp") return "connections:-:oauth";
    if (kind === "artifacts") return "instances:-:artifacts";
    return `instances:-:${kind}`;
}

function mergeInstances(
    configView: Record<string, JsonValue> | undefined,
    runtimeInstances: InstanceListEntry[],
): TuiInstanceListEntry[] {
    const runtimeByName = new Map(runtimeInstances.map((instance) => [instance.name, instance] as const));
    const merged = new Map<string, TuiInstanceListEntry>();
    for (const instance of readConfigInstances(configView)) {
        const runtime = runtimeByName.get(instance.name);
        merged.set(instance.name, {
            ...instance,
            mcpEnabled: runtime?.mcpEnabled ?? instance.mcpEnabled,
        });
    }
    for (const runtime of runtimeInstances) {
        if (!merged.has(runtime.name)) {
            merged.set(runtime.name, {
                enabled: true,
                mcpEnabled: runtime.mcpEnabled,
                name: runtime.name,
            });
        }
    }
    return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function readConfigInstances(
    configView: Record<string, JsonValue> | undefined,
): TuiInstanceListEntry[] {
    const value = configView?.instances;
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        if (
            typeof entry !== "object" || entry === null || Array.isArray(entry) ||
            typeof entry.name !== "string"
        ) return [];
        const mcp = typeof entry.mcp === "object" && entry.mcp !== null && !Array.isArray(entry.mcp)
            ? entry.mcp
            : undefined;
        return [{
            defaultWorkspace: typeof entry.workspace === "string" ? entry.workspace : undefined,
            enabled: entry.enabled !== false,
            mcpEnabled: mcp?.enabled === true,
            mcpPath: typeof mcp?.path === "string" ? mcp.path : undefined,
            name: entry.name,
            provider: typeof entry.provider === "string" ? entry.provider : undefined,
        }];
    });
}

function mapLogEntry(entry: InstanceLogEntry): TuiLogEntry {
    return {
        at: entry.at,
        bytes: Buffer.byteLength(entry.message, "utf8"),
        callId: entry.callId,
        ctxId: entry.ctxId,
        instance: entry.instanceName,
        message: entry.message,
        preview: entry.message.slice(0, 160),
        receivedAt: entry.at,
        requestId: entry.requestId,
        seq: entry.seq,
        source: entry.source,
        stream: entry.stream,
        tail: entry.message.slice(-160),
        toolName: entry.toolName,
    };
}

function refreshPageLabel(page: "audit" | "connections" | "overview" | "todo"): string {
    return page[0]!.toUpperCase() + page.slice(1);
}

function isTuiPresentationEvent(name: string): boolean {
    return isInstanceHealthEvent(name) || name === "log.appended" ||
        name.startsWith("toolCall.") || name.startsWith("approval.") ||
        name.startsWith("context.message.") || name.startsWith("todo.") ||
        name.startsWith("artifact.share") || name.startsWith("artifact.transfer");
}

function isOverviewRefreshEvent(name: string): boolean {
    return isInstanceHealthEvent(name) || name.startsWith("toolCall.") ||
        name.startsWith("approval.") || name.startsWith("todo.");
}

function isInstanceHealthEvent(name: string): boolean {
    return [
        "instance.started", "instance.stopped", "instance.statusChanged",
        "instance.connectionChanged", "instance.readyChanged", "worker.rpcConnected",
        "worker.rpcDisconnected", "reverse.connected", "reverse.disconnected",
        "reverse.enrollmentChanged", "reverse.transportChanged",
    ].includes(name);
}

function toPanelError(error: unknown) {
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown } | undefined;
    return createError({
        code: typeof candidate?.code === "string" ? candidate.code : errorCodes.targetInvalid,
        message: typeof candidate?.message === "string" ? candidate.message : String(error),
        retryable: candidate?.retryable === true,
    });
}

function toFailure(error: unknown): {
    error: { code?: string; message?: string };
    status: "disconnected" | "error";
} {
    const code = readTuiControlErrorCode(error);
    const message = readErrorMessage(error);
    return code === "control.notRunning"
        ? { error: { code, message }, status: "disconnected" }
        : {
              error: { ...(code === undefined ? {} : { code }), message },
              status: "error",
          };
}

export function readTuiControlErrorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error &&
        typeof error.code === "string"
        ? error.code
        : undefined;
}

function readErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (
        typeof error === "object" && error !== null && "message" in error &&
        typeof error.message === "string"
    ) return error.message;
    return String(error);
}
