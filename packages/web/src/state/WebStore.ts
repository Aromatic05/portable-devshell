import {
    CONTROL_PROTOCOL_VERSION,
    type ApprovalRequest,
    type ContextMessageRecord,
    type InstanceEvent,
    type InstanceListEntry,
    type InstanceLogEntry,
    type OAuthApprovalRequest,
    type OperationalOverview,
    type TodoReadResult,
    type ToolCallRecord,
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
    toolCalls: Record<string, ToolCallRecord[]>;
    contextMessages: Record<string, ContextMessageRecord[]>;
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
    toolCalls: {},
    contextMessages: {},
    todos: {},
    partialFailures: {},
    operations: {},
};

export class WebStore {
    #state = initial;
    #listeners = new Set<() => void>();
    #streams = new Map<string, WebRuntimeStream>();
    #logRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
    #todoRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
    #toolCallRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
    #contextMessageRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
    #stopped = false;
    #loadPromise?: Promise<void>;
    #loadGeneration?: number;
    #reconnectPromise?: Promise<void>;
    #generation = 0;
    #overviewRefresh?: ReturnType<typeof setTimeout>;
    #overviewPoll?: ReturnType<typeof setInterval>;
    #overviewPromise?: Promise<void>;
    #overviewGeneration?: number;
    #overviewVersion = 0;
    #oauthApprovalsVersion = 0;
    #readVersions = new Map<string, number>();
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
        if (this.#stopped) {
            return;
        }
        const generation = this.#generation;
        if (this.#loadPromise !== undefined && this.#loadGeneration === generation) {
            return await this.#loadPromise;
        }
        const request = this.loadCurrent(generation);
        this.#loadGeneration = generation;
        this.#loadPromise = request.finally(() => {
            if (this.#loadGeneration === generation) {
                this.#loadPromise = undefined;
                this.#loadGeneration = undefined;
            }
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

    async refreshInstance(name: string, generation = this.#generation): Promise<void> {
        const instanceVersion = this.nextReadVersion(`instance:${name}`);
        const logVersion = this.nextReadVersion(`logs:${name}`);
        const approvalVersion = this.nextReadVersion(`approvals:${name}`);
        try {
            const [envelope, logs, approvals] = await Promise.all([
                this.clients.runtime.refresh(name),
                this.clients.runtime.readLogs(name, { limit: 50 }),
                this.clients.tool.listApprovals(name),
            ]);
            if (!this.isCurrent(generation)) {
                return;
            }
            let next = this.#state;
            if (this.isCurrentRead(`instance:${name}`, instanceVersion)) {
                next = {
                    ...next,
                    instances: next.instances.map((entry) =>
                        entry.name === name
                            ? { ...entry, snapshot: envelope.snapshot }
                            : entry,
                    ),
                };
            }
            if (this.isCurrentRead(`logs:${name}`, logVersion)) {
                next = { ...next, logs: { ...next.logs, [name]: logs.slice(-100) } };
            }
            if (this.isCurrentRead(`approvals:${name}`, approvalVersion)) {
                next = { ...next, approvals: { ...next.approvals, [name]: approvals } };
            }
            if (next !== this.#state) this.set(next);
        } catch (error) {
            if (!this.isCurrent(generation) || (!this.isCurrentRead(`instance:${name}`, instanceVersion) && !this.isCurrentRead(`logs:${name}`, logVersion) && !this.isCurrentRead(`approvals:${name}`, approvalVersion))) {
                return;
            }
            this.setError(error);
        }
    }

    async decideTool(
        instance: string,
        approvalId: string,
        decision: "approve" | "deny",
    ): Promise<void> {
        await this.mutate(`approval:${approvalId}`, "Approval recorded.", async (generation) => {
            await this.clients.tool.decideApproval(
                instance,
                approvalId,
                decision,
            );
            await Promise.all([
                this.refreshInstance(instance, generation),
                this.refreshTodo(instance, generation),
            ]);
        });
    }

    async decideOAuth(
        approvalId: string,
        decision: "approve" | "deny",
    ): Promise<void> {
        await this.mutate(`oauth:${approvalId}`, "Approval recorded.", async (generation) => {
            await this.clients.mcp.decideApproval(approvalId, decision);
            const version = ++this.#oauthApprovalsVersion;
            const oauthApprovals = await this.clients.mcp.listApprovals();
            if (!this.isCurrent(generation) || this.#oauthApprovalsVersion !== version) {
                return;
            }
            this.set({
                ...this.#state,
                oauthApprovals,
            });
        });
    }

    async queueContextMessage(instance: string, ctxId: string, text: string): Promise<boolean> {
        await this.mutate(
            `context-message:${instance}:${ctxId}`,
            "Message queued.",
            async (generation) => {
                const queued = await this.clients.contextMessage.queue(instance, {
                    ctxId,
                    text,
                });
                if (!this.isCurrent(generation)) return;
                const current = this.#state.contextMessages[instance] ?? [];
                this.set({
                    ...this.#state,
                    contextMessages: {
                        ...this.#state.contextMessages,
                        [instance]: [
                            ...current.filter((message) => message.id !== queued.id),
                            queued,
                        ],
                    },
                    partialFailures: this.withoutPartialFailure(
                        `contextMessages:${instance}`,
                    ),
                });
            },
            false,
        );
        return this.#state.notice === "Message queued.";
    }

    async start(instance: string): Promise<void> {
        await this.mutate(`start:${instance}`, `${instance} start requested.`, async (generation) => {
            await this.clients.runtime.start(instance);
            await Promise.all([
                this.refreshInstance(instance, generation),
                this.refreshTodo(instance, generation),
            ]);
        });
    }

    async stop(instance: string): Promise<void> {
        await this.mutate(`stop:${instance}`, `${instance} stop requested.`, async (generation) => {
            await this.clients.runtime.stop(instance);
            await Promise.all([
                this.refreshInstance(instance, generation),
                this.refreshTodo(instance, generation),
            ]);
        });
    }

    close(): void {
        if (this.#stopped) {
            return;
        }
        this.#stopped = true;
        this.#generation += 1;
        this.closeStreams();
        this.clearScheduledRefreshes();
        this.stopOverviewPolling();
        this.clients.close();
    }

    private async loadCurrent(generation: number): Promise<void> {
        if (!this.isCurrent(generation)) {
            return;
        }
        this.set({
            ...this.#state,
            connection: "connecting",
            error: undefined,
        });
        try {
            const hello = await this.clients.service.hello();
            if (!this.isCurrent(generation)) {
                return;
            }
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
            if (!this.isCurrent(generation)) {
                return;
            }
            const oauthApprovals =
                mcpStatus.authMode === "oauth2" && mcpStatus.oauthReady === true
                    ? await this.clients.mcp.listApprovals()
                    : [];
            const approvals: Record<string, ApprovalRequest[]> = {};
            const toolCalls: Record<string, ToolCallRecord[]> = {};
            const contextMessages: Record<string, ContextMessageRecord[]> = {};
            const todos: Record<string, TodoReadResult> = {};
            const partialFailures: Record<string, string> = {};
            await Promise.all(
                instances.map(async ({ name }) => {
                    const [approvalResult, todoResult, toolCallResult, contextMessageResult] = await Promise.allSettled([
                        this.clients.tool.listApprovals(name),
                        this.clients.todo.get(name),
                        this.clients.tool.listCalls(name, { limit: 200 }),
                        this.clients.contextMessage.list(name),
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
                    if (toolCallResult.status === "fulfilled") {
                        toolCalls[name] = toolCallResult.value;
                    } else {
                        partialFailures[`toolCalls:${name}`] = message(toolCallResult.reason);
                    }
                    if (contextMessageResult.status === "fulfilled") {
                        contextMessages[name] = contextMessageResult.value;
                    } else {
                        partialFailures[`contextMessages:${name}`] = message(contextMessageResult.reason);
                    }
                }),
            );
            if (!this.isCurrent(generation)) {
                return;
            }
            this.set({
                ...this.#state,
                connection: "online",
                service,
                instances,
                oauthApprovals,
                approvals,
                toolCalls,
                contextMessages,
                todos,
                partialFailures,
                overview,
            });
            this.startOverviewPolling();
            await Promise.all(
                instances.map(({ name, snapshot }) =>
                    this.beginSubscription(name, snapshot.lastSeq, generation),
                ),
            );
        } catch (error) {
            if (!this.isCurrent(generation)) {
                return;
            }
            this.stopOverviewPolling();
            this.set({
                ...this.#state,
                connection: "offline",
                error: message(error),
            });
        }
    }

    private async reconnectCurrent(): Promise<void> {
        this.#generation += 1;
        this.clearScheduledRefreshes();
        this.closeStreams();
        this.stopOverviewPolling();
        this.set({ ...this.#state, error: undefined, notice: undefined, operations: {} });
        try {
            await this.clients.reconnect();
            if (this.#stopped) {
                return;
            }
            await this.load();
        } catch (error) {
            if (this.#stopped) {
                return;
            }
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
        generation = this.#generation,
    ): Promise<void> {
        if (!this.isCurrent(generation)) {
            return;
        }
        this.#streams.get(name)?.close();
        try {
            const stream = await this.clients.runtime.subscribe(name, fromSeq);
            if (!this.isCurrent(generation)) {
                stream.close();
                return;
            }
            this.#streams.set(name, stream);
            void this.consume(name, stream, generation);
        } catch (error) {
            if (!this.isCurrent(generation)) {
                return;
            }
            this.stopOverviewPolling();
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
        generation: number,
    ): Promise<void> {
        while (this.isCurrent(generation) && this.#streams.get(name) === stream) {
            try {
                const event = await stream.next();
                if (!this.isCurrent(generation) || this.#streams.get(name) !== stream) {
                    return;
                }
                if (event.kind === "gap") {
                    await this.refreshInstance(name, generation);
                    if (!this.isCurrent(generation)) {
                        return;
                    }
                    const lastSeq =
                        this.#state.instances.find(
                            (entry) => entry.name === name,
                        )?.snapshot.lastSeq ?? 0;
                    await this.beginSubscription(name, lastSeq, generation);
                    return;
                }
                if (event.kind === "closed") {
                    this.setPartialFailure(`stream:${name}`, "Subscription closed.");
                    return;
                }
                this.addEvent(name, event.event, generation);
            } catch (error) {
                if (!this.isCurrent(generation)) {
                    return;
                }
                this.setPartialFailure(`stream:${name}`, error);
                return;
            }
        }
    }

    private addEvent(name: string, event: InstanceEvent, generation: number): void {
        this.set({
            ...this.#state,
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
            this.scheduleLogRefresh(name, generation);
        }
        if (event.type.startsWith("approval.")) {
            void this.refreshApprovals(name, generation);
        }
        if (event.type.startsWith("todo.")) {
            this.scheduleTodoRefresh(name, generation);
        }
        if (event.type.startsWith("toolCall.")) {
            this.scheduleToolCallRefresh(name, generation);
        }
        if (event.type.startsWith("context.message.")) {
            this.scheduleContextMessageRefresh(name, generation);
        }
        if (event.type !== "log.appended") {
            this.scheduleOverviewRefresh(generation);
        }
    }

    private scheduleLogRefresh(name: string, generation: number): void {
        if (this.#logRefreshes.has(name)) {
            return;
        }
        const timeout = setTimeout(() => {
            this.#logRefreshes.delete(name);
            void this.readLogs(name, generation);
        }, 250);
        this.#logRefreshes.set(name, timeout);
    }

    private async readLogs(name: string, generation: number): Promise<void> {
        const version = this.nextReadVersion(`logs:${name}`);
        try {
            const logs = await this.clients.runtime.readLogs(name, {
                limit: 50,
            });
            if (!this.isCurrent(generation) || !this.isCurrentRead(`logs:${name}`, version)) {
                return;
            }
            this.set({
                ...this.#state,
                logs: { ...this.#state.logs, [name]: logs.slice(-100) },
                partialFailures: this.withoutPartialFailure(`logs:${name}`),
            });
        } catch (error) {
            if (!this.isCurrent(generation) || !this.isCurrentRead(`logs:${name}`, version)) {
                return;
            }
            this.setPartialFailure(`logs:${name}`, error);
        }
    }

    private scheduleTodoRefresh(name: string, generation: number): void {
        if (this.#todoRefreshes.has(name)) {
            return;
        }
        const timeout = setTimeout(() => {
            this.#todoRefreshes.delete(name);
            void this.refreshTodo(name, generation);
        }, 250);
        this.#todoRefreshes.set(name, timeout);
    }

    private async refreshTodo(name: string, generation: number): Promise<void> {
        const version = this.nextReadVersion(`todos:${name}`);
        try {
            const { todo } = await this.clients.todo.get(name);
            if (!this.isCurrent(generation) || !this.isCurrentRead(`todos:${name}`, version)) {
                return;
            }
            this.set({
                ...this.#state,
                todos: { ...this.#state.todos, [name]: todo },
                partialFailures: this.withoutPartialFailure(`todos:${name}`),
            });
        } catch (error) {
            if (!this.isCurrent(generation) || !this.isCurrentRead(`todos:${name}`, version)) {
                return;
            }
            this.setPartialFailure(`todos:${name}`, error);
        }
    }

    private async refreshApprovals(name: string, generation: number): Promise<void> {
        const version = this.nextReadVersion(`approvals:${name}`);
        try {
            const approvals = await this.clients.tool.listApprovals(name);
            if (!this.isCurrent(generation) || !this.isCurrentRead(`approvals:${name}`, version)) {
                return;
            }
            this.set({
                ...this.#state,
                approvals: { ...this.#state.approvals, [name]: approvals },
                partialFailures: this.withoutPartialFailure(`approvals:${name}`),
            });
        } catch (error) {
            if (!this.isCurrent(generation) || !this.isCurrentRead(`approvals:${name}`, version)) {
                return;
            }
            this.setPartialFailure(`approvals:${name}`, error);
        }
    }

    private scheduleToolCallRefresh(name: string, generation: number): void {
        if (this.#toolCallRefreshes.has(name)) return;
        const timeout = setTimeout(() => {
            this.#toolCallRefreshes.delete(name);
            void this.refreshToolCalls(name, generation);
        }, 250);
        this.#toolCallRefreshes.set(name, timeout);
    }

    private async refreshToolCalls(name: string, generation: number): Promise<void> {
        const version = this.nextReadVersion(`toolCalls:${name}`);
        try {
            const calls = await this.clients.tool.listCalls(name, { limit: 200 });
            if (!this.isCurrent(generation) || !this.isCurrentRead(`toolCalls:${name}`, version)) return;
            this.set({
                ...this.#state,
                toolCalls: { ...this.#state.toolCalls, [name]: calls },
                partialFailures: this.withoutPartialFailure(`toolCalls:${name}`),
            });
        } catch (error) {
            if (!this.isCurrent(generation) || !this.isCurrentRead(`toolCalls:${name}`, version)) return;
            this.setPartialFailure(`toolCalls:${name}`, error);
        }
    }

    private scheduleContextMessageRefresh(name: string, generation: number): void {
        if (this.#contextMessageRefreshes.has(name)) return;
        const timeout = setTimeout(() => {
            this.#contextMessageRefreshes.delete(name);
            void this.refreshContextMessages(name, generation);
        }, 250);
        this.#contextMessageRefreshes.set(name, timeout);
    }

    private async refreshContextMessages(name: string, generation: number): Promise<void> {
        const version = this.nextReadVersion(`contextMessages:${name}`);
        try {
            const messages = await this.clients.contextMessage.list(name);
            if (!this.isCurrent(generation) || !this.isCurrentRead(`contextMessages:${name}`, version)) return;
            this.set({
                ...this.#state,
                contextMessages: { ...this.#state.contextMessages, [name]: messages },
                partialFailures: this.withoutPartialFailure(`contextMessages:${name}`),
            });
        } catch (error) {
            if (!this.isCurrent(generation) || !this.isCurrentRead(`contextMessages:${name}`, version)) return;
            this.setPartialFailure(`contextMessages:${name}`, error);
        }
    }

    private scheduleOverviewRefresh(generation: number): void {
        if (this.#overviewRefresh !== undefined) {
            return;
        }
        this.#overviewRefresh = setTimeout(() => {
            this.#overviewRefresh = undefined;
            void this.refreshOverview(generation);
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
            void this.refreshOverview(this.#generation);
        }, this.#overviewRefreshIntervalMs);
    }

    private stopOverviewPolling(): void {
        if (this.#overviewPoll === undefined) {
            return;
        }
        clearInterval(this.#overviewPoll);
        this.#overviewPoll = undefined;
    }

    private async refreshOverview(generation = this.#generation, force = false): Promise<void> {
        if (!force && this.#overviewPromise !== undefined && this.#overviewGeneration === generation) {
            return await this.#overviewPromise;
        }
        this.#overviewGeneration = generation;
        const version = ++this.#overviewVersion;
        const request = this.clients.overview.get()
            .then((overview) => {
                if (!this.isCurrent(generation) || this.#overviewVersion !== version) {
                    return;
                }
                this.set({
                    ...this.#state,
                    overview,
                    partialFailures: this.withoutPartialFailure("overview"),
                });
            })
            .catch((error: unknown) => {
                if (!this.isCurrent(generation) || this.#overviewVersion !== version) {
                    return;
                }
                this.setPartialFailure("overview", error);
            })
            .finally(() => {
                if (this.#overviewPromise === request) {
                    this.#overviewPromise = undefined;
                    this.#overviewGeneration = undefined;
                }
            });
        this.#overviewPromise = request;
        return await this.#overviewPromise;
    }

    private async mutate(
        operation: string,
        success: string,
        action: (generation: number) => Promise<void>,
        refreshOverview = true,
    ): Promise<void> {
        const generation = this.#generation;
        if (!this.isCurrent(generation)) {
            return;
        }
        if (this.#state.operations[operation] !== undefined) {
            return;
        }
        this.set({
            ...this.#state,
            notice: undefined,
            operations: { ...this.#state.operations, [operation]: "pending" },
        });
        try {
            await action(generation);
            if (!this.isCurrent(generation)) {
                return;
            }
            if (refreshOverview) {
                await this.refreshOverview(generation, true);
                if (!this.isCurrent(generation)) return;
            }
            const { [operation]: _completed, ...operations } = this.#state.operations;
            this.set({ ...this.#state, notice: success, operations });
        } catch (error) {
            if (!this.isCurrent(generation)) {
                return;
            }
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

    private clearScheduledRefreshes(): void {
        for (const timeout of this.#logRefreshes.values()) {
            clearTimeout(timeout);
        }
        this.#logRefreshes.clear();
        for (const timeout of this.#todoRefreshes.values()) {
            clearTimeout(timeout);
        }
        this.#todoRefreshes.clear();
        for (const timeout of this.#toolCallRefreshes.values()) clearTimeout(timeout);
        this.#toolCallRefreshes.clear();
        for (const timeout of this.#contextMessageRefreshes.values()) clearTimeout(timeout);
        this.#contextMessageRefreshes.clear();
        if (this.#overviewRefresh !== undefined) {
            clearTimeout(this.#overviewRefresh);
            this.#overviewRefresh = undefined;
        }
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

    private withoutPartialFailure(key: string): Record<string, string> {
        const { [key]: _recovered, ...partialFailures } = this.#state.partialFailures;
        return partialFailures;
    }

    private nextReadVersion(key: string): number {
        const version = (this.#readVersions.get(key) ?? 0) + 1;
        this.#readVersions.set(key, version);
        return version;
    }

    private isCurrentRead(key: string, version: number): boolean {
        return this.#readVersions.get(key) === version;
    }

    private isCurrent(generation: number): boolean {
        return !this.#stopped && this.#generation === generation;
    }

    private set(state: WebState): void {
        if (this.#stopped) {
            return;
        }
        this.#state = state;
        for (const listener of this.#listeners) {
            listener();
        }
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
