import {
    CONTROL_PROTOCOL_VERSION,
    type ApprovalRequest,
    type InstanceEvent,
    type InstanceListEntry,
    type InstanceLogEntry,
    type OAuthApprovalRequest,
    type OperationalOverview,
    type TodoReadResult,
} from "@portable-devshell/shared/browser";

import type { WebClients, WebRuntimeStream } from "../client/WebClients.js";

export type ConnectionState = "connecting" | "online" | "offline";

export interface WebStoreOptions {
    isPageVisible?: () => boolean;
    overviewRefreshIntervalMs?: number;
}

export interface WebState {
    connection: ConnectionState;
    error?: string;
    service?: { instanceCount: number; ok: boolean; pid?: number };
    instances: InstanceListEntry[];
    approvals: Record<string, ApprovalRequest[]>;
    oauthApprovals: OAuthApprovalRequest[];
    logs: Record<string, InstanceLogEntry[]>;
    activity: InstanceEvent[];
    todos: Record<string, TodoReadResult>;
    partialFailures: Record<string, string>;
    operations: Record<string, "pending">;
    notice?: string;
    overview?: OperationalOverview;
}

const initial: WebState = {
    connection: "connecting",
    instances: [],
    approvals: {},
    oauthApprovals: [],
    logs: {},
    activity: [],
    todos: {},
    partialFailures: {},
    operations: {},
};

export class WebStore {
    #state = initial;
    #listeners = new Set<() => void>();
    #streams = new Map<string, WebRuntimeStream>();
    #logRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
    #stopped = false;
    #loadPromise?: Promise<void>;
    #reconnectPromise?: Promise<void>;
    #overviewRefresh?: ReturnType<typeof setTimeout>;
    #overviewPoll?: ReturnType<typeof setInterval>;
    #overviewPromise?: Promise<void>;
    readonly #isPageVisible: () => boolean;
    readonly #overviewRefreshIntervalMs: number;

    constructor(readonly clients: WebClients, options: WebStoreOptions = {}) {
        this.#isPageVisible = options.isPageVisible ?? (() =>
            typeof document === "undefined" || document.visibilityState !== "hidden"
        );
        this.#overviewRefreshIntervalMs = options.overviewRefreshIntervalMs ?? 5_000;
    }

    get state(): WebState {
        return this.#state;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        this.startOverviewPolling();
        return () => {
            this.#listeners.delete(listener);
            if (this.#listeners.size === 0) {
                this.stopOverviewPolling();
            }
        };
    }

    async load(): Promise<void> {
        if (this.#loadPromise !== undefined) {
            return await this.#loadPromise;
        }
        this.#loadPromise = this.loadCurrent().finally(() => {
            this.#loadPromise = undefined;
        });
        return await this.#loadPromise;
    }

    async reconnect(): Promise<void> {
        if (this.#reconnectPromise !== undefined) {
            return await this.#reconnectPromise;
        }
        this.#reconnectPromise = this.reconnectCurrent().finally(() => {
            this.#reconnectPromise = undefined;
        });
        return await this.#reconnectPromise;
    }

    async refreshInstance(name: string): Promise<void> {
        try {
            const [envelope, logs, approvals] = await Promise.all([
                this.clients.runtime.refresh(name),
                this.clients.runtime.readLogs(name, { limit: 50 }),
                this.clients.tool.listApprovals(name),
            ]);
            this.set({
                ...this.#state,
                instances: this.#state.instances.map((entry) =>
                    entry.name === name
                        ? { ...entry, snapshot: envelope.snapshot }
                        : entry,
                ),
                logs: { ...this.#state.logs, [name]: logs.slice(-100) },
                approvals: { ...this.#state.approvals, [name]: approvals },
            });
        } catch (error) {
            this.setError(error);
        }
    }

    async decideTool(
        instance: string,
        approvalId: string,
        decision: "approve" | "deny",
    ): Promise<void> {
        await this.mutate(`approval:${approvalId}`, "Approval recorded.", async () => {
            await this.clients.tool.decideApproval(
                instance,
                approvalId,
                decision,
            );
            await this.refreshInstance(instance);
        });
    }

    async decideOAuth(
        approvalId: string,
        decision: "approve" | "deny",
    ): Promise<void> {
        await this.mutate(`oauth:${approvalId}`, "Approval recorded.", async () => {
            await this.clients.mcp.decideApproval(approvalId, decision);
            this.set({
                ...this.#state,
                oauthApprovals: await this.clients.mcp.listApprovals(),
            });
        });
    }

    async start(instance: string): Promise<void> {
        await this.mutate(`start:${instance}`, `${instance} start requested.`, async () => {
            await this.clients.runtime.start(instance);
            await this.refreshInstance(instance);
        });
    }

    async stop(instance: string): Promise<void> {
        await this.mutate(`stop:${instance}`, `${instance} stop requested.`, async () => {
            await this.clients.runtime.stop(instance);
            await this.refreshInstance(instance);
        });
    }

    close(): void {
        if (this.#stopped) {
            return;
        }
        this.#stopped = true;
        this.closeStreams();
        for (const timeout of this.#logRefreshes.values()) {
            clearTimeout(timeout);
        }
        this.#logRefreshes.clear();
        if (this.#overviewRefresh !== undefined) {
            clearTimeout(this.#overviewRefresh);
        }
        this.stopOverviewPolling();
        this.clients.close();
    }

    private async loadCurrent(): Promise<void> {
        this.set({
            ...this.#state,
            connection: "connecting",
            error: undefined,
        });
        try {
            const hello = await this.clients.service.hello();
            if (hello.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
                throw new Error(
                    `Incompatible control protocol version: ${hello.protocolVersion}.`,
                );
            }
            const [service, instances, mcpStatus, overview] = await Promise.all([
                this.clients.service.status(),
                this.clients.instance.list(),
                this.clients.mcp.status(),
                this.clients.overview.get(),
            ]);
            const oauthApprovals =
                mcpStatus.authMode === "oauth2" && mcpStatus.oauthReady === true
                    ? await this.clients.mcp.listApprovals()
                    : [];
            const approvals: Record<string, ApprovalRequest[]> = {};
            const todos: Record<string, TodoReadResult> = {};
            const partialFailures: Record<string, string> = {};
            await Promise.all(
                instances.map(async ({ name }) => {
                    const [approvalResult, todoResult] = await Promise.allSettled([
                        this.clients.tool.listApprovals(name),
                        this.clients.todo.get(name),
                    ]);
                    if (approvalResult.status === "fulfilled") {
                        approvals[name] = approvalResult.value;
                    } else {
                        partialFailures[`approvals:${name}`] = message(approvalResult.reason);
                    }
                    if (todoResult.status === "fulfilled") {
                        todos[name] = todoResult.value.todo;
                    } else {
                        partialFailures[`todos:${name}`] = message(todoResult.reason);
                    }
                }),
            );
            this.set({
                ...this.#state,
                connection: "online",
                service,
                instances,
                oauthApprovals,
                approvals,
                todos,
                partialFailures,
                overview,
            });
            this.startOverviewPolling();
            await Promise.all(
                instances.map(({ name, snapshot }) =>
                    this.beginSubscription(name, snapshot.lastSeq),
                ),
            );
        } catch (error) {
            this.stopOverviewPolling();
            this.set({
                ...this.#state,
                connection: "offline",
                error: message(error),
            });
        }
    }

    private async reconnectCurrent(): Promise<void> {
        this.closeStreams();
        this.stopOverviewPolling();
        try {
            await this.clients.reconnect();
            await this.load();
        } catch (error) {
            this.set({
                ...this.#state,
                connection: "offline",
                error: message(error),
            });
        }
    }

    private async beginSubscription(
        name: string,
        fromSeq: number,
    ): Promise<void> {
        if (this.#stopped) {
            return;
        }
        this.#streams.get(name)?.close();
        try {
            const stream = await this.clients.runtime.subscribe(name, fromSeq);
            if (this.#stopped) {
                stream.close();
                return;
            }
            this.#streams.set(name, stream);
            void this.consume(name, stream);
        } catch (error) {
            this.set({
                ...this.#state,
                connection: "offline",
                error: message(error),
            });
        }
    }

    private async consume(
        name: string,
        stream: WebRuntimeStream,
    ): Promise<void> {
        while (!this.#stopped && this.#streams.get(name) === stream) {
            try {
                const event = await stream.next();
                if (event.kind === "gap") {
                    await this.refreshInstance(name);
                    const lastSeq =
                        this.#state.instances.find(
                            (entry) => entry.name === name,
                        )?.snapshot.lastSeq ?? 0;
                    await this.beginSubscription(name, lastSeq);
                    return;
                }
                if (event.kind === "closed") {
                    this.setPartialFailure(`stream:${name}`, "Subscription closed.");
                    return;
                }
                this.addEvent(name, event.event);
            } catch (error) {
                this.setPartialFailure(`stream:${name}`, error);
                return;
            }
        }
    }

    private addEvent(name: string, event: InstanceEvent): void {
        const activity = [...this.#state.activity, event]
            .sort((left, right) => left.at.localeCompare(right.at))
            .slice(-200);
        this.set({
            ...this.#state,
            activity,
            instances: this.#state.instances.map((entry) =>
                entry.name === name
                    ? {
                          ...entry,
                          snapshot: {
                              ...entry.snapshot,
                              lastSeq: Math.max(
                                  entry.snapshot.lastSeq,
                                  event.seq,
                              ),
                          },
                      }
                    : entry,
            ),
        });
        if (event.type === "log.appended") {
            this.scheduleLogRefresh(name);
        }
        if (event.type.startsWith("approval.")) {
            void this.refreshApprovals(name);
        }
        if (event.type !== "log.appended") {
            this.scheduleOverviewRefresh();
        }
    }

    private scheduleLogRefresh(name: string): void {
        if (this.#logRefreshes.has(name)) {
            return;
        }
        const timeout = setTimeout(() => {
            this.#logRefreshes.delete(name);
            void this.readLogs(name);
        }, 250);
        this.#logRefreshes.set(name, timeout);
    }

    private async readLogs(name: string): Promise<void> {
        try {
            const logs = await this.clients.runtime.readLogs(name, {
                limit: 50,
            });
            this.set({
                ...this.#state,
                logs: { ...this.#state.logs, [name]: logs.slice(-100) },
            });
        } catch (error) {
            this.setPartialFailure(`logs:${name}`, error);
        }
    }

    private async refreshApprovals(name: string): Promise<void> {
        try {
            const approvals = await this.clients.tool.listApprovals(name);
            this.set({
                ...this.#state,
                approvals: { ...this.#state.approvals, [name]: approvals },
            });
        } catch (error) {
            this.setPartialFailure(`approvals:${name}`, error);
        }
    }

    private scheduleOverviewRefresh(): void {
        if (this.#overviewRefresh !== undefined) {
            return;
        }
        this.#overviewRefresh = setTimeout(() => {
            this.#overviewRefresh = undefined;
            void this.refreshOverview();
        }, 250);
    }

    private startOverviewPolling(): void {
        if (
            this.#overviewPoll !== undefined ||
            this.#overviewRefreshIntervalMs <= 0 ||
            this.#listeners.size === 0 ||
            this.#state.connection !== "online" ||
            this.#stopped
        ) {
            return;
        }
        this.#overviewPoll = setInterval(() => {
            if (
                this.#state.connection !== "online" ||
                !this.#isPageVisible()
            ) {
                return;
            }
            void this.refreshOverview();
        }, this.#overviewRefreshIntervalMs);
    }

    private stopOverviewPolling(): void {
        if (this.#overviewPoll === undefined) {
            return;
        }
        clearInterval(this.#overviewPoll);
        this.#overviewPoll = undefined;
    }

    private async refreshOverview(): Promise<void> {
        if (this.#overviewPromise !== undefined) {
            return await this.#overviewPromise;
        }
        this.#overviewPromise = this.clients.overview.get()
            .then((overview) => {
                this.set({ ...this.#state, overview });
            })
            .catch((error: unknown) => {
                this.setPartialFailure("overview", error);
            })
            .finally(() => {
                this.#overviewPromise = undefined;
            });
        return await this.#overviewPromise;
    }

    private async mutate(
        operation: string,
        success: string,
        action: () => Promise<void>,
    ): Promise<void> {
        if (this.#state.operations[operation] !== undefined) {
            return;
        }
        this.set({
            ...this.#state,
            notice: undefined,
            operations: { ...this.#state.operations, [operation]: "pending" },
        });
        try {
            await action();
            await this.refreshOverview();
            const { [operation]: _completed, ...operations } = this.#state.operations;
            this.set({ ...this.#state, notice: success, operations });
        } catch (error) {
            const { [operation]: _failed, ...operations } = this.#state.operations;
            this.set({ ...this.#state, error: message(error), operations });
        }
    }

    private closeStreams(): void {
        for (const stream of this.#streams.values()) {
            stream.close();
        }
        this.#streams.clear();
    }

    private setError(error: unknown): void {
        this.set({ ...this.#state, error: message(error) });
    }

    private setPartialFailure(key: string, error: unknown): void {
        this.set({
            ...this.#state,
            partialFailures: {
                ...this.#state.partialFailures,
                [key]: message(error),
            },
        });
    }

    private set(state: WebState): void {
        this.#state = state;
        for (const listener of this.#listeners) {
            listener();
        }
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
