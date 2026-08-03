import type { InstanceEvent } from "@portable-devshell/shared/browser";

import type { WebClients } from "../client/WebClients.js";
import { ApprovalDecisionGuard } from "./ApprovalDecisionGuard.js";
import { WebBootstrapLoader } from "./WebBootstrapLoader.js";
import { InstanceReadModelCoordinator } from "./InstanceReadModelCoordinator.js";
import { InstanceStreamSupervisor } from "./InstanceStreamSupervisor.js";
import { OperationalOverviewCoordinator } from "./OperationalOverviewCoordinator.js";
import { WebOperationCoordinator } from "./WebOperationCoordinator.js";
import { withWebRequestTimeout } from "./WebRequestTimeout.js";
import {
    createInitialWebState,
    type WebState,
} from "./WebState.js";

export type { ConnectionState, WebState } from "./WebState.js";

export interface WebStoreOptions {
    isPageVisible?: () => boolean;
    operationTimeoutMs?: number;
    overviewRefreshIntervalMs?: number;
    requestTimeoutMs?: number;
    streamRetryBaseMs?: number;
    streamStableAfterMs?: number;
}

export class WebStore {
    #state = createInitialWebState();
    #listeners = new Set<() => void>();
    readonly #approvalGuard = new ApprovalDecisionGuard();
    readonly #bootstrap: WebBootstrapLoader;
    readonly #instanceModels: InstanceReadModelCoordinator;
    readonly #streamSupervisor: InstanceStreamSupervisor;
    readonly #overview: OperationalOverviewCoordinator;
    readonly #operations: WebOperationCoordinator;
    readonly #requestTimeoutMs: number;
    readonly #offTransportClose: () => void;
    #stopped = false;
    #loadPromise?: Promise<void>;
    #loadGeneration?: number;
    #reconnectPromise?: Promise<void>;
    #generation = 0;
    #oauthApprovalsVersion = 0;
    #ignoreTransportClose = false;

    constructor(readonly clients: WebClients, options: WebStoreOptions = {}) {
        const isPageVisible = options.isPageVisible ?? (() =>
            typeof document === "undefined" || document.visibilityState !== "hidden"
        );
        this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
        const access = {
            getState: () => this.#state,
            isCurrent: (generation: number) => this.isCurrent(generation),
            setState: (state: WebState) => this.set(state),
        };
        this.#instanceModels = new InstanceReadModelCoordinator(
            clients,
            access,
            this.#approvalGuard,
            this.#requestTimeoutMs,
        );
        this.#bootstrap = new WebBootstrapLoader(
            clients,
            this.#instanceModels,
            this.#approvalGuard,
            this.#requestTimeoutMs,
        );
        this.#overview = new OperationalOverviewCoordinator(
            clients,
            {
                currentGeneration: () => this.#generation,
                ...access,
                isVisible: isPageVisible,
            },
            options.overviewRefreshIntervalMs ?? 5_000,
            this.#requestTimeoutMs,
        );
        this.#operations = new WebOperationCoordinator(
            access,
            options.operationTimeoutMs ?? 30_000,
        );
        this.#streamSupervisor = new InstanceStreamSupervisor(
            clients,
            {
                currentSequence: (name) => this.currentSequence(name),
                isCurrent: (generation) => this.isCurrent(generation),
                onEvent: (name, event, generation) =>
                    this.addEvent(name, event, generation),
                onFailure: (name, error) =>
                    this.setPartialFailure(`stream:${name}`, error),
                onGap: async (name, generation) => {
                    await this.#instanceModels.refreshAll(name, generation);
                    return this.currentSequence(name);
                },
                onRecovered: (name) =>
                    this.clearPartialFailure(`stream:${name}`),
            },
            {
                retryBaseMs: options.streamRetryBaseMs,
                stableAfterMs: options.streamStableAfterMs,
            },
        );
        this.#offTransportClose = clients.onTransportClose((error) =>
            this.transportClosed(error)
        );
    }

    get state(): WebState {
        return this.#state;
    }

    readonly subscribe = (listener: () => void): (() => void) => {
        this.#listeners.add(listener);
        this.#overview.setObserved(true);
        return () => {
            this.#listeners.delete(listener);
            this.#overview.setObserved(this.#listeners.size > 0);
        };
    };

    async load(): Promise<void> {
        if (this.#stopped) return;
        const generation = this.#generation;
        if (
            this.#loadPromise !== undefined &&
            this.#loadGeneration === generation
        ) return await this.#loadPromise;
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

    async refreshInstance(
        name: string,
        generation = this.#generation,
    ): Promise<void> {
        await this.#instanceModels.refreshAll(name, generation);
    }

    async decideTool(
        instance: string,
        approvalId: string,
        decision: "approve" | "deny",
    ): Promise<void> {
        const generation = this.#generation;
        await this.#operations.run(
            `approval:${approvalId}`,
            "Approval recorded.",
            generation,
            async (signal) => {
                const decided = await this.clients.tool.decideApproval(
                    instance,
                    approvalId,
                    decision,
                );
                if (signal.aborted || !this.isCurrent(generation)) return;
                this.#instanceModels.recordToolDecision(instance, decided.approvalId);
                void this.#instanceModels.refreshAfterToolDecision(instance, generation);
                void this.#overview.refresh(generation, true);
            },
        );
    }

    async decideOAuth(
        approvalId: string,
        decision: "approve" | "deny",
    ): Promise<void> {
        const generation = this.#generation;
        await this.#operations.run(
            `oauth:${approvalId}`,
            "Approval recorded.",
            generation,
            async (signal) => {
                const decided = await this.clients.mcp.decideApproval(
                    approvalId,
                    decision,
                );
                if (signal.aborted || !this.isCurrent(generation)) return;
                this.#approvalGuard.recordOAuth(decided.approvalId);
                this.#oauthApprovalsVersion += 1;
                this.set({
                    ...this.#state,
                    oauthApprovals: this.#state.oauthApprovals.filter(
                        (approval) => approval.approvalId !== decided.approvalId,
                    ),
                });
                void this.refreshOAuthApprovals(generation);
                void this.#overview.refresh(generation, true);
            },
        );
    }

    async queueContextMessage(
        instance: string,
        ctxId: string,
        text: string,
    ): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `context-message:${instance}:${ctxId}`,
            "Message queued.",
            generation,
            async (signal) => {
                const queued = await this.clients.contextMessage.queue(instance, {
                    ctxId,
                    text,
                });
                if (signal.aborted || !this.isCurrent(generation)) return;
                this.#instanceModels.mergeQueuedContextMessage(instance, queued);
            },
        );
    }

    async start(instance: string): Promise<void> {
        await this.lifecycle(instance, "start");
    }

    async stop(instance: string): Promise<void> {
        await this.lifecycle(instance, "stop");
    }

    close(): void {
        if (this.#stopped) return;
        this.#stopped = true;
        this.#generation += 1;
        this.#offTransportClose();
        this.#operations.cancelAll(new Error("Web store closed."));
        this.#streamSupervisor.closeAll();
        this.#instanceModels.reset();
        this.#overview.stop();
        this.clients.close();
    }

    private async lifecycle(
        instance: string,
        action: "start" | "stop",
    ): Promise<void> {
        const generation = this.#generation;
        await this.#operations.run(
            `${action}:${instance}`,
            `${instance} ${action} requested.`,
            generation,
            async (signal) => {
                const snapshot = action === "start"
                    ? await this.clients.runtime.start(instance, signal)
                    : await this.clients.runtime.stop(instance);
                if (signal.aborted || !this.isCurrent(generation)) return;
                this.#instanceModels.applyAuthoritativeSnapshot(instance, snapshot);
                void this.#instanceModels.refreshAll(instance, generation);
                void this.#overview.refresh(generation, true);
            },
        );
    }

    private async loadCurrent(generation: number): Promise<void> {
        if (!this.isCurrent(generation)) return;
        this.set({
            ...this.#state,
            connection: "connecting",
            error: undefined,
        });
        try {
            const loaded = await this.#bootstrap.load();
            if (!this.isCurrent(generation)) return;
            this.set({
                ...this.#state,
                approvals: loaded.instanceModels.approvals,
                commentCalls: loaded.instanceModels.commentCalls,
                connection: "online",
                contextMessages: loaded.instanceModels.contextMessages,
                instances: loaded.instances,
                logs: loaded.instanceModels.logs,
                oauthApprovals: loaded.oauthApprovals,
                overview: loaded.overview,
                partialFailures: loaded.partialFailures,
                service: loaded.service,
                todos: loaded.instanceModels.todos,
                toolCalls: loaded.instanceModels.toolCalls,
            });
            for (const { name, snapshot } of loaded.instances) {
                void this.#streamSupervisor.start(name, snapshot.lastSeq, generation);
            }
        } catch (error) {
            if (!this.isCurrent(generation)) return;
            this.#overview.stop();
            this.set({
                ...this.#state,
                connection: "offline",
                error: errorMessage(error),
            });
        }
    }

    private async reconnectCurrent(): Promise<void> {
        this.#generation += 1;
        const generation = this.#generation;
        this.#operations.cancelAll(new Error("Web connection is reconnecting."));
        this.#streamSupervisor.closeAll();
        this.#instanceModels.reset();
        this.#overview.stop();
        this.set({
            ...this.#state,
            connection: "connecting",
            error: undefined,
            notice: undefined,
            operations: {},
        });
        this.#ignoreTransportClose = true;
        try {
            await this.request(this.clients.reconnect(), "control.reconnect");
        } catch (error) {
            if (this.isCurrent(generation)) {
                this.set({
                    ...this.#state,
                    connection: "offline",
                    error: errorMessage(error),
                });
            }
            return;
        } finally {
            this.#ignoreTransportClose = false;
        }
        if (this.isCurrent(generation)) await this.load();
    }

    private addEvent(
        name: string,
        event: InstanceEvent,
        generation: number,
    ): void {
        this.set({
            ...this.#state,
            instances: this.#state.instances.map((entry) =>
                entry.name === name
                    ? {
                          ...entry,
                          snapshot: {
                              ...entry.snapshot,
                              lastSeq: Math.max(entry.snapshot.lastSeq, event.seq),
                          },
                      }
                    : entry,
            ),
        });
        this.#instanceModels.handleEvent(name, event, generation);
        if (event.type !== "log.appended") this.#overview.schedule(generation);
    }

    private async refreshOAuthApprovals(generation: number): Promise<void> {
        const version = ++this.#oauthApprovalsVersion;
        try {
            const approvals = await this.request(
                this.clients.mcp.listApprovals(),
                "mcp.listApprovals",
            );
            if (
                !this.isCurrent(generation) ||
                version !== this.#oauthApprovalsVersion
            ) return;
            this.set({
                ...this.#state,
                oauthApprovals: this.#approvalGuard.filterOAuth(approvals),
                partialFailures: this.withoutPartialFailure("oauthApprovals"),
            });
        } catch (error) {
            if (
                this.isCurrent(generation) &&
                version === this.#oauthApprovalsVersion
            ) this.setPartialFailure("oauthApprovals", error);
        }
    }

    private transportClosed(error: Error): void {
        if (this.#stopped || this.#ignoreTransportClose) return;
        this.#generation += 1;
        this.#operations.cancelAll(error);
        this.#streamSupervisor.closeAll();
        this.#instanceModels.reset();
        this.#overview.stop();
        this.set({
            ...this.#state,
            connection: "offline",
            error: error.message,
            notice: undefined,
            operations: {},
        });
    }

    private async request<T>(request: Promise<T>, label: string): Promise<T> {
        return await withWebRequestTimeout(request, this.#requestTimeoutMs, label);
    }

    private setPartialFailure(key: string, error: unknown): void {
        this.set({
            ...this.#state,
            partialFailures: {
                ...this.#state.partialFailures,
                [key]: errorMessage(error),
            },
        });
    }

    private clearPartialFailure(key: string): void {
        if (this.#state.partialFailures[key] === undefined) return;
        this.set({
            ...this.#state,
            partialFailures: this.withoutPartialFailure(key),
        });
    }

    private withoutPartialFailure(key: string): Record<string, string> {
        const { [key]: _removed, ...partialFailures } = this.#state.partialFailures;
        return partialFailures;
    }

    private currentSequence(name: string): number {
        return this.#state.instances.find((entry) => entry.name === name)
            ?.snapshot.lastSeq ?? 0;
    }

    private isCurrent(generation: number): boolean {
        return !this.#stopped && this.#generation === generation;
    }

    private set(state: WebState): void {
        if (this.#stopped) return;
        const connectionChanged = state.connection !== this.#state.connection;
        this.#state = state;
        if (connectionChanged) {
            this.#overview.setOnline(state.connection === "online");
        }
        for (const listener of this.#listeners) listener();
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
