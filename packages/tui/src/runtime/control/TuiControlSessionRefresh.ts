import type {
    InstanceListEntry,
    InstanceLogEntry,
    InstanceRuntimeEnvelope,
    JsonValue
} from "@portable-devshell/shared";

import type { TuiClients } from "../client/TuiClientComposition.js";
import type { TuiAppStore } from "../../state/TuiAppStore.js";
import type {
    TuiInstanceListEntry,
    TuiLogEntry
} from "../../state/reducer/TuiStoreModel.js";

const LOG_READ_LIMIT = 100;
const TOOL_CALL_READ_LIMIT = 100;

export interface TuiControlSubscriptionRequest {
    fromSeq: number;
    instance: string;
}

export interface TuiControlSessionRefreshOptions {
    clients: TuiClients;
    isCurrent?: (generation: number) => boolean;
    store: TuiAppStore;
}

export class TuiControlSessionRefresh {
    readonly #clients: TuiClients;
    readonly #isCurrent: (generation: number) => boolean;
    readonly #store: TuiAppStore;

    constructor(options: TuiControlSessionRefreshOptions) {
        this.#clients = options.clients;
        this.#isCurrent = options.isCurrent ?? (() => true);
        this.#store = options.store;
    }

    async refreshAll(generation?: number): Promise<TuiControlSubscriptionRequest[]> {
        await this.refreshOverview(generation);
        if (!this.#current(generation)) return [];
        const configView = await this.#readConfigView();
        const runtimeInstances = await this.#clients.instance.list();
        const mcpStatus = await this.#clients.mcp.status();
        if (!this.#current(generation)) return [];
        this.#store.setMcpStatus(mcpStatus);
        this.#store.replaceInstances(
            mergeInstances(configView, runtimeInstances)
        );
        this.#store.setConfigView(configView);
        await this.#reloadOAuthApprovals(configView, generation);
        await this.refreshArtifacts(generation);
        if (!this.#current(generation)) return [];

        const subscriptions: TuiControlSubscriptionRequest[] = [];
        for (const instance of runtimeInstances) {
            if (!this.#current(generation)) break;
            subscriptions.push({
                fromSeq: await this.refreshRuntimeInstance(instance.name, generation),
                instance: instance.name
            });
        }
        return subscriptions;
    }

    async refreshConfig(generation?: number): Promise<void> {
        const configView = await this.#readConfigView();
        const runtimeInstances = await this.#clients.instance.list();
        const mcpStatus = await this.#clients.mcp.status();
        if (!this.#current(generation)) return;
        this.#store.setMcpStatus(mcpStatus);
        this.#store.replaceInstances(
            mergeInstances(configView, runtimeInstances)
        );
        this.#store.setConfigView(configView);
    }

    async refreshOverview(generation?: number): Promise<void> {
        try {
            const overview = await this.#clients.overview.get();
            if (this.#current(generation)) this.#store.replaceOperationalOverview(overview);
        } catch (error) {
            if (readErrorCode(error) !== "control.methodNotFound") {
                throw error;
            }
            if (this.#current(generation)) this.#store.replaceOperationalOverview(undefined);
        }
    }

    async refreshOAuth(generation?: number): Promise<void> {
        await this.#reloadOAuthApprovals(
            this.#store.getState().configView,
            generation
        );
    }

    oauthApprovalsAvailable(): boolean {
        return !oauthApprovalsUnavailable(this.#store.getState().configView);
    }

    async refreshAudit(instance: string, generation?: number): Promise<void> {
        await this.#reloadToolCalls(instance, generation);
        await this.#reloadApprovals(instance, generation);
    }

    async refreshLogsForInstance(instance: string, generation?: number): Promise<void> {
        await this.#reloadLogs(instance, generation);
    }

    async refreshTodo(instance: string, generation?: number): Promise<void> {
        await this.#reloadTodo(instance, generation);
    }

    async refreshArtifacts(generation?: number): Promise<void> {
        try {
            const [shares, transfers] = await Promise.all([
                this.#clients.artifact.listShares(),
                this.#clients.artifact.listTransfers()
            ]);
            if (!this.#current(generation)) return;
            this.#store.replaceArtifactShares(shares);
            this.#store.replaceArtifactTransfers(transfers);
        } catch (error) {
            if (readErrorCode(error) !== "control.methodNotFound") {
                throw error;
            }
            if (!this.#current(generation)) return;
            this.#store.replaceArtifactShares([]);
            this.#store.replaceArtifactTransfers([]);
        }
    }

    async refreshLogs(generation?: number): Promise<void> {
        for (const instance of this.#runtimeInstanceNames()) {
            await this.#reloadLogs(instance, generation);
        }
    }

    async refreshRuntimeInstance(instance: string, generation?: number): Promise<number> {
        const snapshotEnvelope = await this.#clients.runtime.snapshot(instance);
        if (!this.#current(generation)) return nextSubscribeSeq(snapshotEnvelope);
        this.#store.replaceSnapshot(snapshotEnvelope.snapshot);
        await this.#reloadTodo(instance, generation);
        await this.#reloadLogs(instance, generation);
        await this.#reloadToolCalls(instance, generation);
        await this.#reloadApprovals(instance, generation);
        return nextSubscribeSeq(snapshotEnvelope);
    }

    async refreshInstance(instance: string, generation?: number): Promise<number> {
        return await this.refreshRuntimeInstance(instance, generation);
    }

    async #reloadTodo(instance: string, generation?: number): Promise<void> {
        const envelope = await this.#clients.todo.get(instance);
        if (this.#current(generation)) this.#store.replaceTodo(instance, envelope.todo);
    }

    async #reloadLogs(instance: string, generation?: number): Promise<void> {
        const logs = await this.#clients.runtime.readLogs(instance, {
            limit: LOG_READ_LIMIT
        });
        if (this.#current(generation)) this.#store.replaceLogs(instance, logs.map(mapLogEntry));
    }

    async #reloadToolCalls(instance: string, generation?: number): Promise<void> {
        const records = await this.#clients.tool.listCalls(instance, {
            limit: TOOL_CALL_READ_LIMIT
        });
        if (this.#current(generation)) this.#store.replaceToolCalls(instance, records);
    }

    async #reloadApprovals(instance: string, generation?: number): Promise<void> {
        const approvals = await this.#clients.tool.listApprovals(instance);
        if (this.#current(generation)) this.#store.replaceApprovals(instance, approvals);
    }

    async #reloadOAuthApprovals(
        configView: Record<string, JsonValue> | undefined,
        generation?: number
    ): Promise<void> {
        if (oauthApprovalsUnavailable(configView)) {
            if (this.#current(generation)) this.#store.replaceOAuthApprovals([]);
            return;
        }
        const approvals = await this.#clients.mcp.listApprovals();
        if (this.#current(generation)) this.#store.replaceOAuthApprovals(approvals);
    }

    #runtimeInstanceNames(): string[] {
        const state = this.#store.getState();
        return state.instances
            .filter((instance) => {
                return state.snapshotsByInstance[instance.name] !== undefined;
            })
            .map((instance) => instance.name);
    }

    async #readConfigView(): Promise<
        Record<string, JsonValue> | undefined
    > {
        try {
            return await this.#clients.config.get();
        } catch (error) {
            if (readErrorCode(error) === "control.methodNotFound") {
                return undefined;
            }
            throw error;
        }
    }

    #current(generation: number | undefined): boolean {
        return generation === undefined || this.#isCurrent(generation);
    }
}

function oauthApprovalsUnavailable(
    configView: Record<string, JsonValue> | undefined
): boolean {
    const mcp = configView?.mcp;
    if (typeof mcp !== "object" || mcp === null || Array.isArray(mcp)) {
        return true;
    }
    const auth = mcp.auth;
    return typeof auth !== "object" ||
        auth === null ||
        Array.isArray(auth) ||
        auth.mode !== "oauth2";
}

function nextSubscribeSeq(snapshotEnvelope: InstanceRuntimeEnvelope): number {
    return Math.max(snapshotEnvelope.lastSeq, 1);
}

function mergeInstances(
    configView: Record<string, JsonValue> | undefined,
    runtimeInstances: InstanceListEntry[]
): TuiInstanceListEntry[] {
    const runtimeByName = new Map(
        runtimeInstances.map((instance) => [instance.name, instance] as const)
    );
    const merged = new Map<string, TuiInstanceListEntry>();

    for (const instance of readConfigInstances(configView)) {
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

    return [...merged.values()].sort((left, right) => {
        return left.name.localeCompare(right.name);
    });
}

function readConfigInstances(
    configView: Record<string, JsonValue> | undefined
): TuiInstanceListEntry[] {
    const value = configView?.instances;
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((entry) => {
        if (
            typeof entry !== "object" ||
            entry === null ||
            Array.isArray(entry) ||
            typeof entry.name !== "string"
        ) {
            return [];
        }
        const mcp = typeof entry.mcp === "object" &&
            entry.mcp !== null &&
            !Array.isArray(entry.mcp)
            ? entry.mcp
            : undefined;
        return [{
            defaultWorkspace: typeof entry.workspace === "string"
                ? entry.workspace
                : undefined,
            enabled: entry.enabled !== false,
            mcpEnabled: mcp?.enabled === true,
            mcpPath: typeof mcp?.path === "string"
                ? mcp.path
                : undefined,
            name: entry.name,
            provider: typeof entry.provider === "string"
                ? entry.provider
                : undefined
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
        toolName: entry.toolName
    };
}

export function readTuiControlErrorCode(error: unknown): string | undefined {
    return readErrorCode(error);
}

function readErrorCode(error: unknown): string | undefined {
    if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error)
    ) {
        return undefined;
    }
    return typeof error.code === "string" ? error.code : undefined;
}
