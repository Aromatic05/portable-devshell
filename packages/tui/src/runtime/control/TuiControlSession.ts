import {
    ControlCommands,
    ControlReadModel,
    ControlRefreshScheduler,
    errorMessage,
    toControlError,
    withRequestTimeout,
    type ControlReadModelState,
    type InstanceEvent,
    type InstanceListEntry,
    type InstanceSnapshot,
    type JsonValue,
    type TodoReadInput,
} from "@portable-devshell/shared";
import {
    createTuiClients as createControlClients,
    type TuiClients,
} from "../client/TuiClientComposition.js";
import { TuiAppStore } from "../../state/TuiAppStore.js";
import type { TuiInstanceListEntry } from "../../state/reducer/TuiStoreModel.js";
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
    readonly #commands: ControlCommands;
    readonly #model: ControlReadModel;
    readonly #readTimeoutMs: number;
    readonly #refreshScheduler: ControlRefreshScheduler;
    readonly #store: TuiAppStore;
    readonly #appliedPanelFailures = new Set<string>();
    readonly #offTransportClose: () => void;
    #started = false;
    #generation = 0;

    constructor(options: TuiControlSessionOptions = {}) {
        this.#clients = options.clients ?? createControlClients();
        this.#readTimeoutMs = options.readTimeoutMs ?? 10_000;
        this.#store = options.store ?? new TuiAppStore();
        this.#model = new ControlReadModel({
            clients: this.#clients,
            onEvent: (event) => this.#handleInstanceEvent(event),
            requestTimeoutMs: this.#readTimeoutMs,
            retryBaseMs: options.subscriptionRetryBaseMs,
            scheduleDelayMs: 50,
            stableAfterMs: options.subscriptionStableAfterMs,
        });
        this.#commands = new ControlCommands({
            clients: this.#clients,
            model: this.#model,
            timeoutMs: 30_000,
        });
        this.#refreshScheduler = new ControlRefreshScheduler({
            model: this.#model,
            onFailure: (kind, error) =>
                this.#reportRefreshFailure(kind === "oauth" ? "connections" : "overview", error),
            onSuccess: (kind) =>
                this.#clearRefreshFailure(kind === "oauth" ? "connections" : "overview"),
            overviewIntervalMs: options.overviewRefreshIntervalMs,
            shouldRefreshOAuth: () => {
                const status = this.#model.state.mcpStatus;
                return this.#started &&
                    this.#store.getState().connection.status === "connected" &&
                    status?.authMode === "oauth2" &&
                    status.oauthReady === true &&
                    status.running === true;
            },
            shouldRefreshOverview: () =>
                this.#started &&
                this.#store.getState().connection.status === "connected" &&
                this.#store.getState().ui.selectedPage === "overview",
        });
        this.#model.subscribe(() => this.#syncModel());
        this.#offTransportClose = this.#clients.onTransportClose(() => this.#handleDisconnected());
    }

    get store(): TuiAppStore {
        return this.#store;
    }

    get commands(): ControlCommands {
        return this.#commands;
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
            this.#refreshScheduler.start();
        }
    }

    async stop(): Promise<void> {
        this.#generation += 1;
        this.#started = false;
        this.#stopBackgroundRefresh();
        this.#offTransportClose();
        this.#commands.reset();
        this.#model.close();
        this.#clients.close();
    }

    async reconnect(): Promise<void> {
        if (!this.#started) return;
        const generation = ++this.#generation;
        this.#stopBackgroundRefresh();
        this.#commands.reset();
        this.#model.reset();
        try {
            await withRequestTimeout(
                this.#clients.reconnect(),
                this.#readTimeoutMs,
                "control.reconnect",
            );
            this.#assertCurrent(generation, "Control connection changed while reconnecting.");
            await this.#load(generation);
            this.#assertCurrent(generation, "Control connection changed while refreshing after reconnect.");
            this.#refreshScheduler.start();
        } catch (error) {
            if (this.#current(generation)) this.#applyConnectionFailure(error);
            throw error;
        }
    }

    async refreshConfig(generation = this.#generation, signal?: AbortSignal): Promise<void> {
        if (!this.#canRefresh(generation, signal)) return;
        await this.#model.refreshControl();
    }

    async refreshInstances(generation = this.#generation, signal?: AbortSignal): Promise<void> {
        if (!this.#canRefresh(generation, signal)) return;
        await this.#model.refreshInstances();
    }

    async refreshOverview(generation = this.#generation, signal?: AbortSignal): Promise<void> {
        if (this.#canRefresh(generation, signal)) await this.#refreshScheduler.refresh("overview");
    }

    async refreshOAuth(generation = this.#generation, signal?: AbortSignal): Promise<void> {
        if (this.#canRefresh(generation, signal)) await this.#refreshScheduler.refresh("oauth");
    }

    async refreshAudit(
        instance: string,
        generation = this.#generation,
        signal?: AbortSignal,
    ): Promise<void> {
        if (!this.#canRefresh(generation, signal)) return;
        await this.#model.refreshInstance(
            instance,
            ["toolCalls", "approvals", "comments"],
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
        input?: TodoReadInput,
    ): Promise<void> {
        if (this.#canRefresh(generation, signal)) {
            await this.#model.refreshInstance(instance, ["todo"], input);
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
        this.#store.replaceControlReadModel(
            model,
            mergeInstances(model.configView, model.instances),
        );
        this.#store.setControlRestartRequired(model.configView?.restartControlRequired === true);
        this.#syncFailures(model);
    }

    #syncFailures(model: Readonly<ControlReadModelState>): void {
        const next = new Map<string, Error[]>();
        for (const failure of Object.values(model.failures)) {
            const panel = tuiFailurePanel(failure);
            const errors = next.get(panel) ?? [];
            errors.push(failure.error);
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
                toControlError(new Error(errors.map((error) => error.message).join("; "))),
            );
        }
    }

    #handleInstanceEvent(event: InstanceEvent): void {
        if (!this.#started || !isTuiPresentationEvent(event.type)) return;
        this.#store.applyInstanceEvent(event);
        if (
            event.type === "worker.rpcConnected" ||
            event.type === "instance.readyChanged" ||
            event.type === "instance.stopped"
        ) {
            void this.refreshInstances();
        }
        if (
            this.#store.getState().ui.selectedPage === "overview" &&
            isOverviewRefreshEvent(event.type)
        ) this.#refreshScheduler.scheduleOverview(75);
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
        this.#commands.reset();
        this.#model.reset();
    }

    #applyConnectionFailure(error: unknown): void {
        this.#generation += 1;
        const failure = toFailure(error);
        this.#store.setConnectionState(failure.status, failure.error);
        this.#stopBackgroundRefresh();
        this.#commands.reset();
        this.#model.reset();
    }

    #stopBackgroundRefresh(): void {
        this.#refreshScheduler.stop();
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
                `${refreshPageLabel(page)} refresh failed: ${errorMessage(error)}`,
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

function tuiFailurePanel(
    failure: ControlReadModelState["failures"][string],
): string {
    const instance = failure.instance ?? "-";
    if (failure.key === "snapshot") return `instances:${instance}:snapshot`;
    if (failure.key === "stream") return `instances:${instance}:subscription`;
    if (failure.key === "logs") return `logs:${instance}:logs`;
    if (failure.key === "todo") return `todo:${instance}:todo`;
    if (["approvals", "toolCalls", "comments"].includes(failure.key)) {
        return `audit:${instance}:readModels`;
    }
    if (failure.key === "overview") return "overview:-:overview";
    if (failure.key === "oauthApprovals" || failure.key === "mcp") {
        return "connections:-:oauth";
    }
    if (failure.key === "artifacts") return "instances:-:artifacts";
    return `instances:-:${failure.key}`;
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
            homeDirectory: runtime?.homeDirectory,
            mcpEnabled: runtime?.mcpEnabled ?? instance.mcpEnabled,
        });
    }
    for (const runtime of runtimeInstances) {
        if (!merged.has(runtime.name)) {
            merged.set(runtime.name, {
                enabled: true,
                homeDirectory: runtime.homeDirectory,
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
            enabled: entry.enabled !== false,
            mcpEnabled: mcp?.enabled === true,
            mcpPath: typeof mcp?.path === "string" ? mcp.path : undefined,
            name: entry.name,
            provider: typeof entry.provider === "string" ? entry.provider : undefined,
        }];
    });
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

function toFailure(error: unknown): {
    error: { code?: string; message?: string };
    status: "disconnected" | "error";
} {
    const code = readTuiControlErrorCode(error);
    const message = errorMessage(error);
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
