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
    store: TuiAppStore;
}

export class TuiControlSessionRefresh {
    readonly #clients: TuiClients;
    readonly #store: TuiAppStore;

    constructor(options: TuiControlSessionRefreshOptions) {
        this.#clients = options.clients;
        this.#store = options.store;
    }

    async refreshAll(): Promise<TuiControlSubscriptionRequest[]> {
        const configView = await this.#readConfigView();
        const runtimeInstances = await this.#clients.instance.list();
        this.#store.setMcpStatus(await this.#clients.mcp.status());
        this.#store.replaceInstances(
            mergeInstances(configView, runtimeInstances)
        );
        this.#store.setConfigView(configView);
        await this.#reloadOAuthApprovals(configView);
        await this.refreshArtifacts();

        const subscriptions: TuiControlSubscriptionRequest[] = [];
        for (const instance of runtimeInstances) {
            subscriptions.push({
                fromSeq: await this.refreshRuntimeInstance(instance.name),
                instance: instance.name
            });
        }
        return subscriptions;
    }

    async refreshConfig(): Promise<void> {
        const configView = await this.#readConfigView();
        const runtimeInstances = await this.#clients.instance.list();
        this.#store.setMcpStatus(await this.#clients.mcp.status());
        this.#store.replaceInstances(
            mergeInstances(configView, runtimeInstances)
        );
        this.#store.setConfigView(configView);
    }

    async refreshOAuth(): Promise<void> {
        await this.#reloadOAuthApprovals(
            this.#store.getState().configView
        );
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
        for (const instance of this.#runtimeInstanceNames()) {
            await this.#reloadLogs(instance);
        }
    }

    async refreshRuntimeInstance(instance: string): Promise<number> {
        const snapshotEnvelope = await this.#clients.runtime.snapshot(instance);
        this.#store.replaceSnapshot(snapshotEnvelope.snapshot);
        await this.#reloadTodo(instance);
        await this.#reloadLogs(instance);
        await this.#reloadToolCalls(instance);
        await this.#reloadApprovals(instance);
        return nextSubscribeSeq(snapshotEnvelope);
    }

    async refreshInstance(instance: string): Promise<number> {
        return await this.refreshRuntimeInstance(instance);
    }

    async #reloadTodo(instance: string): Promise<void> {
        const envelope = await this.#clients.todo.get(instance);
        this.#store.replaceTodo(instance, envelope.todo);
    }

    async #reloadLogs(instance: string): Promise<void> {
        const logs = await this.#clients.runtime.readLogs(instance, {
            limit: LOG_READ_LIMIT
        });
        this.#store.replaceLogs(instance, logs.map(mapLogEntry));
    }

    async #reloadToolCalls(instance: string): Promise<void> {
        const records = await this.#clients.tool.listCalls(instance, {
            limit: TOOL_CALL_READ_LIMIT
        });
        this.#store.replaceToolCalls(instance, records);
    }

    async #reloadApprovals(instance: string): Promise<void> {
        const approvals = await this.#clients.tool.listApprovals(instance);
        this.#store.replaceApprovals(instance, approvals);
    }

    async #reloadOAuthApprovals(
        configView: Record<string, JsonValue> | undefined
    ): Promise<void> {
        if (oauthApprovalsUnavailable(configView)) {
            this.#store.replaceOAuthApprovals([]);
            return;
        }
        this.#store.replaceOAuthApprovals(
            await this.#clients.mcp.listApprovals()
        );
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
