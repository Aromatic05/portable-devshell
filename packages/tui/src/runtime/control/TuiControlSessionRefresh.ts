import {
    createError,
    errorCodes,
    type InstanceListEntry,
    type InstanceLogEntry,
    type InstanceRuntimeEnvelope,
    type InstanceSnapshot,
    type JsonValue
} from "@portable-devshell/shared";

import type { TuiClients } from "../client/TuiClientComposition.js";
import type { TuiAppStore } from "../../state/TuiAppStore.js";
import type {
    TuiInstanceListEntry,
    TuiLogEntry
} from "../../state/reducer/TuiStoreModel.js";
import { withTuiRequestTimeout } from "./TuiRequestTimeout.js";

const LOG_READ_LIMIT = 100;
const COMMENT_CALL_READ_LIMIT = 1_000;
const TOOL_CALL_READ_LIMIT = 100;

export interface TuiControlSubscriptionRequest {
    fromSeq: number;
    instance: string;
}

export interface TuiControlSessionRefreshOptions {
    clients: TuiClients;
    isCurrent?: (generation: number) => boolean;
    readTimeoutMs?: number;
    store: TuiAppStore;
}

export class TuiControlSessionRefresh {
    readonly #authoritativeSnapshots = new Map<string, InstanceSnapshot>();
    readonly #clients: TuiClients;
    readonly #isCurrent: (generation: number) => boolean;
    readonly #readTimeoutMs: number;
    readonly #requestVersions = new Map<string, number>();
    readonly #store: TuiAppStore;

    constructor(options: TuiControlSessionRefreshOptions) {
        this.#clients = options.clients;
        this.#isCurrent = options.isCurrent ?? (() => true);
        this.#readTimeoutMs = options.readTimeoutMs ?? 10_000;
        this.#store = options.store;
    }

    applyAuthoritativeSnapshot(snapshot: InstanceSnapshot): void {
        this.#beginRequest(`snapshot:${snapshot.name}`);
        this.#authoritativeSnapshots.set(snapshot.name, snapshot);
        this.#store.replaceSnapshot(snapshot);
    }

    async refreshAll(generation?: number): Promise<TuiControlSubscriptionRequest[]> {
        const [configView, runtimeInstances, mcpStatus] = await Promise.all([
            this.#request(this.#readConfigView(), "config.get"),
            this.#request(this.#clients.instance.list(), "instance.list"),
            this.#request(this.#clients.mcp.status(), "mcp.status")
        ]);
        if (!this.#current(generation)) return [];
        this.#store.setMcpStatus(mcpStatus);
        this.#store.replaceInstances(mergeInstances(configView, runtimeInstances));
        this.#store.setConfigView(configView);
        this.#store.setControlRestartRequired(configView?.restartControlRequired === true);

        await Promise.all([
            this.refreshOverview(generation),
            this.refreshOAuth(generation),
            this.refreshArtifacts(generation)
        ]);
        if (!this.#current(generation)) return [];

        const subscriptions: TuiControlSubscriptionRequest[] = [];
        for (const instance of runtimeInstances) {
            if (!this.#current(generation)) break;
            const fromSeq = await this.refreshRuntimeInstance(instance.name, generation);
            if (fromSeq !== undefined) subscriptions.push({ fromSeq, instance: instance.name });
        }
        return subscriptions;
    }

    async refreshConfig(generation?: number, signal?: AbortSignal): Promise<void> {
        const [configView, runtimeInstances, mcpStatus] = await Promise.all([
            this.#request(this.#readConfigView(), "config.get"),
            this.#request(this.#clients.instance.list(), "instance.list"),
            this.#request(this.#clients.mcp.status(), "mcp.status")
        ]);
        if (!this.#current(generation, signal)) return;
        this.#store.setMcpStatus(mcpStatus);
        this.#store.replaceInstances(mergeInstances(configView, runtimeInstances));
        this.#store.setConfigView(configView);
        this.#store.setControlRestartRequired(configView?.restartControlRequired === true);
    }

    async refreshOverview(generation?: number, signal?: AbortSignal): Promise<void> {
        const key = "overview";
        const version = this.#beginRequest(key);
        try {
            const overview = await this.#request(this.#clients.overview.get(), "overview.get");
            if (!this.#current(generation, signal) || !this.#latestRequest(key, version)) return;
            this.#store.replaceOperationalOverview(overview);
            this.#store.setPanelError("overview:-:overview", undefined);
        } catch (error) {
            if (!this.#current(generation, signal) || !this.#latestRequest(key, version)) return;
            if (readErrorCode(error) === "control.methodNotFound") {
                this.#store.replaceOperationalOverview(undefined);
                this.#store.setPanelError("overview:-:overview", undefined);
                return;
            }
            this.#store.setPanelError("overview:-:overview", toPanelError(error));
        }
    }

    async refreshOAuth(generation?: number, signal?: AbortSignal): Promise<void> {
        const key = "oauth";
        const version = this.#beginRequest(key);
        if (oauthApprovalsUnavailable(this.#store.getState().mcpStatus)) {
            if (this.#current(generation, signal) && this.#latestRequest(key, version)) {
                this.#store.replaceOAuthApprovals([]);
                this.#setPageError("connections", undefined);
            }
            return;
        }
        try {
            const approvals = await this.#request(this.#clients.mcp.listApprovals(), "mcp.approvals.list");
            if (!this.#current(generation, signal) || !this.#latestRequest(key, version)) return;
            this.#store.replaceOAuthApprovals(approvals);
            this.#setPageError("connections", undefined);
        } catch (error) {
            if (this.#current(generation, signal) && this.#latestRequest(key, version)) this.#setPageError("connections", error);
        }
    }

    oauthApprovalsAvailable(): boolean {
        return !oauthApprovalsUnavailable(this.#store.getState().mcpStatus);
    }

    async refreshAudit(instance: string, generation?: number, signal?: AbortSignal): Promise<void> {
        await this.#refreshGroup(`audit:${instance}:readModels`, generation, signal, [
            ["tool calls", () => this.#reloadToolCalls(instance, generation, signal)],
            ["approvals", () => this.#reloadApprovals(instance, generation, signal)],
            ["comments", () => this.#reloadCommentHistory(instance, generation, signal)]
        ]);
    }

    async refreshLogsForInstance(instance: string, generation?: number, signal?: AbortSignal): Promise<void> {
        await this.#refreshGroup(`logs:${instance}:logs`, generation, signal, [
            ["logs", () => this.#reloadLogs(instance, generation, signal)]
        ]);
    }

    async refreshTodo(instance: string, generation?: number, signal?: AbortSignal, title?: string): Promise<void> {
        await this.#refreshGroup(`todo:${instance}:todo`, generation, signal, [
            ["todo", () => this.#reloadTodo(instance, generation, signal, title)]
        ]);
    }

    async refreshArtifacts(generation?: number): Promise<void> {
        const key = "artifacts";
        const version = this.#beginRequest(key);
        try {
            const [shares, transfers] = await Promise.all([
                this.#request(this.#clients.artifact.listShares(), "artifact.shares.list"),
                this.#request(this.#clients.artifact.listTransfers(), "artifact.transfers.list")
            ]);
            if (!this.#current(generation) || !this.#latestRequest(key, version)) return;
            this.#store.replaceArtifactShares(shares);
            this.#store.replaceArtifactTransfers(transfers);
            this.#setPageError("instances", undefined);
        } catch (error) {
            if (!this.#current(generation) || !this.#latestRequest(key, version)) return;
            if (readErrorCode(error) === "control.methodNotFound") {
                this.#store.replaceArtifactShares([]);
                this.#store.replaceArtifactTransfers([]);
                this.#setPageError("instances", undefined);
                return;
            }
            this.#setPageError("instances", error);
        }
    }

    async refreshLogs(generation?: number): Promise<void> {
        await Promise.all(this.#runtimeInstanceNames().map(async (instance) => {
            await this.refreshLogsForInstance(instance, generation);
        }));
    }

    async refreshRuntimeInstance(instance: string, generation?: number): Promise<number | undefined> {
        const key = `snapshot:${instance}`;
        const version = this.#beginRequest(key);
        let snapshotEnvelope: InstanceRuntimeEnvelope;
        try {
            snapshotEnvelope = await this.#request(
                this.#clients.runtime.snapshot(instance),
                `runtime.snapshot:${instance}`
            );
        } catch (error) {
            if (this.#current(generation) && this.#latestRequest(key, version)) this.#store.setPanelError(`instances:${instance}:snapshot`, toPanelError(error));
            return undefined;
        }
        if (!this.#current(generation) || !this.#latestRequest(key, version)) return undefined;
        const authoritativeSeq = this.#applySnapshotRead(snapshotEnvelope.snapshot);
        this.#store.setPanelError(`instances:${instance}:snapshot`, undefined);
        await Promise.all([
            this.refreshTodo(instance, generation),
            this.refreshLogsForInstance(instance, generation),
            this.refreshAudit(instance, generation)
        ]);
        return Math.max(nextSubscribeSeq(snapshotEnvelope), authoritativeSeq);
    }

    async refreshInstance(instance: string, generation?: number): Promise<number | undefined> {
        return await this.refreshRuntimeInstance(instance, generation);
    }

    async #reloadCommentHistory(instance: string, generation?: number, signal?: AbortSignal): Promise<void> {
        const key = `commentHistory:${instance}`;
        const version = this.#beginRequest(key);
        const client = this.#clients.contextMessage;
        if (client === undefined) {
            if (this.#current(generation, signal) && this.#latestRequest(key, version)) {
                this.#store.replaceContextMessages(instance, []);
                this.#store.replaceCommentCalls(instance, []);
            }
            return;
        }
        try {
            const messages = await this.#request(client.list(instance), `contextMessage.list:${instance}`);
            if (!this.#current(generation, signal) || !this.#latestRequest(key, version)) return;
            this.#store.replaceContextMessages(instance, messages);
            const callIds = [...new Set(messages.flatMap((message) =>
                message.status === "delivered" && message.callId !== undefined
                    ? [message.callId]
                    : []
            ))];
            if (callIds.length === 0) {
                this.#store.replaceCommentCalls(instance, []);
                return;
            }
            const records = await this.#request(
                this.#clients.tool.listCalls(instance, {
                    callIds,
                    limit: COMMENT_CALL_READ_LIMIT,
                }),
                `tool.commentCalls:${instance}`,
            );
            if (this.#current(generation, signal) && this.#latestRequest(key, version)) {
                this.#store.replaceCommentCalls(instance, records);
            }
        } catch (error) {
            if (readErrorCode(error) !== "control.methodNotFound") throw error;
            if (this.#current(generation, signal) && this.#latestRequest(key, version)) {
                this.#store.replaceContextMessages(instance, []);
                this.#store.replaceCommentCalls(instance, []);
            }
        }
    }

    async #reloadTodo(instance: string, generation?: number, signal?: AbortSignal, title?: string): Promise<void> {
        const key = `todo:${instance}`;
        const version = this.#beginRequest(key);
        const envelope = await this.#request(this.#clients.todo.get(instance, title), `todo.get:${instance}`);
        if (this.#current(generation, signal) && this.#latestRequest(key, version)) this.#store.replaceTodo(instance, envelope.todo);
    }

    async #reloadLogs(instance: string, generation?: number, signal?: AbortSignal): Promise<void> {
        const key = `logs:${instance}`;
        const version = this.#beginRequest(key);
        const logs = await this.#request(
            this.#clients.runtime.readLogs(instance, { limit: LOG_READ_LIMIT }),
            `runtime.logs:${instance}`
        );
        if (this.#current(generation, signal) && this.#latestRequest(key, version)) this.#store.replaceLogs(instance, logs.map(mapLogEntry));
    }

    async #reloadToolCalls(instance: string, generation?: number, signal?: AbortSignal): Promise<void> {
        const key = `toolCalls:${instance}`;
        const version = this.#beginRequest(key);
        const records = await this.#request(
            this.#clients.tool.listCalls(instance, { limit: TOOL_CALL_READ_LIMIT }),
            `tool.calls:${instance}`
        );
        if (this.#current(generation, signal) && this.#latestRequest(key, version)) this.#store.replaceToolCalls(instance, records);
    }

    async #reloadApprovals(instance: string, generation?: number, signal?: AbortSignal): Promise<void> {
        const key = `approvals:${instance}`;
        const version = this.#beginRequest(key);
        const approvals = await this.#request(
            this.#clients.tool.listApprovals(instance),
            `tool.approvals:${instance}`
        );
        if (this.#current(generation, signal) && this.#latestRequest(key, version)) this.#store.replaceApprovals(instance, approvals);
    }

    async #refreshGroup(
        panelKey: string,
        generation: number | undefined,
        signal: AbortSignal | undefined,
        requests: ReadonlyArray<readonly [string, () => Promise<void>]>
    ): Promise<void> {
        const version = this.#beginRequest(`group:${panelKey}`);
        const results = await Promise.allSettled(requests.map(([, request]) => request()));
        if (!this.#current(generation, signal) || !this.#latestRequest(`group:${panelKey}`, version)) return;
        const failures = results.flatMap((result, index) =>
            result.status === "rejected"
                ? [`${requests[index]?.[0] ?? "read"}: ${readErrorMessage(result.reason)}`]
                : []
        );
        this.#store.setPanelError(
            panelKey,
            failures.length === 0 ? undefined : toPanelError(new Error(failures.join("; ")))
        );
    }

    #setPageError(page: "connections" | "instances", error: unknown | undefined): void {
        const instances = this.#store.getState().instances;
        if (instances.length === 0) {
            this.#store.setPanelError(`${page}:-:${page === "instances" ? "artifacts" : "oauth"}`, error === undefined ? undefined : toPanelError(error));
            return;
        }
        for (const instance of instances) {
            this.#store.setPanelError(
                `${page}:${instance.name}:${page === "instances" ? "artifacts" : "oauth"}`,
                error === undefined ? undefined : toPanelError(error)
            );
        }
    }

    #runtimeInstanceNames(): string[] {
        const state = this.#store.getState();
        return state.instances
            .filter((instance) => state.snapshotsByInstance[instance.name] !== undefined)
            .map((instance) => instance.name);
    }

    async #readConfigView(): Promise<Record<string, JsonValue> | undefined> {
        try {
            return await this.#clients.config.get();
        } catch (error) {
            if (readErrorCode(error) === "control.methodNotFound") return undefined;
            throw error;
        }
    }

    async #request<T>(request: Promise<T>, label: string): Promise<T> {
        return await withTuiRequestTimeout(request, this.#readTimeoutMs, label);
    }

    #applySnapshotRead(snapshot: InstanceSnapshot): number {
        const fence = this.#authoritativeSnapshots.get(snapshot.name);
        if (fence === undefined) {
            this.#store.replaceSnapshot(snapshot);
            return snapshot.lastSeq;
        }
        if (snapshot.lastSeq < fence.lastSeq) return fence.lastSeq;
        if (snapshot.lastSeq === fence.lastSeq) {
            this.#store.replaceSnapshot(fence);
            return fence.lastSeq;
        }
        this.#authoritativeSnapshots.delete(snapshot.name);
        this.#store.replaceSnapshot(snapshot);
        return snapshot.lastSeq;
    }

    #beginRequest(key: string): number {
        const version = (this.#requestVersions.get(key) ?? 0) + 1;
        this.#requestVersions.set(key, version);
        return version;
    }

    #latestRequest(key: string, version: number): boolean {
        return this.#requestVersions.get(key) === version;
    }

    #current(generation: number | undefined, signal?: AbortSignal): boolean {
        return signal?.aborted !== true && (generation === undefined || this.#isCurrent(generation));
    }
}

function toPanelError(error: unknown) {
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown } | undefined;
    return createError({
        code: typeof candidate?.code === "string" ? candidate.code : errorCodes.targetInvalid,
        message: typeof candidate?.message === "string" ? candidate.message : String(error),
        retryable: candidate?.retryable === true
    });
}

function readErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function oauthApprovalsUnavailable(
    status: Record<string, JsonValue> | undefined
): boolean {
    return status?.authMode !== "oauth2" ||
        status.oauthReady !== true ||
        status.running !== true;
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
