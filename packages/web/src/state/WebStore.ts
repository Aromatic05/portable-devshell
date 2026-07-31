import {
    CONTROL_PROTOCOL_VERSION,
    type InstanceEvent,
    type OAuthApprovalRequest,
} from "@portable-devshell/shared/browser";

import type { WebClients } from "../client/WebClients.js";
import { ApprovalDecisionGuard } from "./ApprovalDecisionGuard.js";
import { InstanceReadModelCoordinator } from "./InstanceReadModelCoordinator.js";
import { InstanceStreamSupervisor } from "./InstanceStreamSupervisor.js";
import { OperationalOverviewCoordinator } from "./OperationalOverviewCoordinator.js";
import {
    createInitialWebState,
    type WebState,
} from "./WebState.js";

export type { ConnectionState, WebState } from "./WebState.js";

export interface WebStoreOptions {
    isPageVisible?: () => boolean;
    overviewRefreshIntervalMs?: number;
    streamRetryBaseMs?: number;
}

export class WebStore {
    #state = createInitialWebState();
    #listeners = new Set<() => void>();
    readonly #approvalGuard = new ApprovalDecisionGuard();
    readonly #instanceModels: InstanceReadModelCoordinator;
    readonly #streamSupervisor: InstanceStreamSupervisor;
    readonly #overview: OperationalOverviewCoordinator;
    #stopped = false;
    #loadPromise?: Promise<void>;
    #loadGeneration?: number;
    #reconnectPromise?: Promise<void>;
    #generation = 0;
    #oauthApprovalsVersion = 0;

    constructor(readonly clients: WebClients, options: WebStoreOptions = {}) {
        const isPageVisible = options.isPageVisible ?? (() =>
            typeof document === "undefined" || document.visibilityState !== "hidden"
        );
        this.#instanceModels = new InstanceReadModelCoordinator(
            clients,
            {
                getState: () => this.#state,
                isCurrent: (generation) => this.isCurrent(generation),
                setState: (state) => this.set(state),
            },
            this.#approvalGuard,
        );
        this.#overview = new OperationalOverviewCoordinator(
            clients,
            {
                currentGeneration: () => this.#generation,
                getState: () => this.#state,
                isCurrent: (generation) => this.isCurrent(generation),
                isVisible: isPageVisible,
                setState: (state) => this.set(state),
            },
            options.overviewRefreshIntervalMs ?? 5_000,
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
            options.streamRetryBaseMs ?? 1_000,
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
        await this.mutate(
            `approval:${approvalId}`,
            "Approval recorded.",
            async (generation) => {
                const decided = await this.clients.tool.decideApproval(
                    instance,
                    approvalId,
                    decision,
                );
                if (!this.isCurrent(generation)) return;
                this.#instanceModels.recordToolDecision(
                    instance,
                    decided.approvalId,
                );
                await this.#instanceModels.refreshAfterToolDecision(
                    instance,
                    generation,
                );
            },
        );
    }

    async decideOAuth(
        approvalId: string,
        decision: "approve" | "deny",
    ): Promise<void> {
        await this.mutate(
            `oauth:${approvalId}`,
            "Approval recorded.",
            async (generation) => {
                const decided = await this.clients.mcp.decideApproval(
                    approvalId,
                    decision,
                );
                if (!this.isCurrent(generation)) return;
                this.#approvalGuard.recordOAuth(decided.approvalId);
                this.#oauthApprovalsVersion += 1;
                this.set({
                    ...this.#state,
                    oauthApprovals: this.#state.oauthApprovals.filter(
                        (approval) => approval.approvalId !== decided.approvalId,
                    ),
                });
                await this.refreshOAuthApprovals(generation);
            },
        );
    }

    async queueContextMessage(
        instance: string,
        ctxId: string,
        text: string,
    ): Promise<boolean> {
        return await this.mutate(
            `context-message:${instance}:${ctxId}`,
            "Message queued.",
            async (generation) => {
                const queued = await this.clients.contextMessage.queue(instance, {
                    ctxId,
                    text,
                });
                if (!this.isCurrent(generation)) return;
                this.#instanceModels.mergeQueuedContextMessage(instance, queued);
            },
            false,
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
        this.#streamSupervisor.closeAll();
        this.clearScheduledRefreshes();
        this.#overview.stop();
        this.clients.close();
    }

    private async lifecycle(
        instance: string,
        action: "start" | "stop",
    ): Promise<void> {
        await this.mutate(
            `${action}:${instance}`,
            `${instance} ${action} requested.`,
            async (generation) => {
                const snapshot = await this.clients.runtime[action](instance);
                if (!this.isCurrent(generation)) return;
                this.#instanceModels.applyAuthoritativeSnapshot(instance, snapshot);
                await this.#instanceModels.refreshAll(instance, generation);
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
            const hello = await this.clients.service.hello();
            if (!this.isCurrent(generation)) return;
            if (hello.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
                throw new Error(
                    `Incompatible control protocol version: ${hello.protocolVersion}.`,
                );
            }
            const [service, instances] = await Promise.all([
                this.clients.service.status(),
                this.clients.instance.list(),
            ]);
            if (!this.isCurrent(generation)) return;

            const partialFailures: Record<string, string> = {};
            const [mcpStatusResult, overviewResult] = await Promise.allSettled([
                this.clients.mcp.status(),
                this.clients.overview.get(),
            ]);
            const overview = overviewResult.status === "fulfilled"
                ? overviewResult.value
                : undefined;
            if (overviewResult.status === "rejected") {
                partialFailures.overview = errorMessage(overviewResult.reason);
            }

            const oauthApprovals = await this.loadOAuthApprovals(
                mcpStatusResult,
                partialFailures,
            );
            const instanceModels = await this.#instanceModels.loadInitial(
                instances.map(({ name }) => name),
            );
            Object.assign(partialFailures, instanceModels.failures);
            if (!this.isCurrent(generation)) return;

            this.set({
                ...this.#state,
                approvals: instanceModels.approvals,
                connection: "online",
                contextMessages: instanceModels.contextMessages,
                instances,
                logs: instanceModels.logs,
                oauthApprovals,
                overview,
                partialFailures,
                service,
                todos: instanceModels.todos,
                toolCalls: instanceModels.toolCalls,
            });
            await Promise.all(instances.map(({ name, snapshot }) =>
                this.#streamSupervisor.start(
                    name,
                    snapshot.lastSeq,
                    generation,
                )
            ));
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

    private async loadOAuthApprovals(
        mcpStatus: PromiseSettledResult<{
            authMode?: "none" | "oauth2" | "token";
            oauthReady?: boolean;
            running: boolean;
        }>,
        partialFailures: Record<string, string>,
    ): Promise<OAuthApprovalRequest[]> {
        if (mcpStatus.status === "rejected") {
            partialFailures.mcp = errorMessage(mcpStatus.reason);
            return [];
        }
        if (
            mcpStatus.value.authMode !== "oauth2" ||
            mcpStatus.value.oauthReady !== true
        ) return [];
        try {
            return this.#approvalGuard.filterOAuth(
                await this.clients.mcp.listApprovals(),
            );
        } catch (error) {
            partialFailures.oauthApprovals = errorMessage(error);
            return [];
        }
    }

    private async reconnectCurrent(): Promise<void> {
        this.#generation += 1;
        this.clearScheduledRefreshes();
        this.#streamSupervisor.closeAll();
        this.#overview.stop();
        this.set({
            ...this.#state,
            error: undefined,
            notice: undefined,
            operations: {},
        });
        try {
            await this.clients.reconnect();
            if (!this.#stopped) await this.load();
        } catch (error) {
            if (this.#stopped) return;
            this.set({
                ...this.#state,
                connection: "offline",
                error: errorMessage(error),
            });
        }
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
        if (event.type !== "log.appended") {
            this.#overview.schedule(generation)
        }
    }

    private async refreshOAuthApprovals(generation: number): Promise<void> {
        const version = ++this.#oauthApprovalsVersion;
        try {
            const approvals = await this.clients.mcp.listApprovals();
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

    private async mutate(
        operation: string,
        success: string,
        action: (generation: number) => Promise<void>,
        refreshOverview = true,
    ): Promise<boolean> {
        const generation = this.#generation;
        if (
            !this.isCurrent(generation) ||
            this.#state.operations[operation] !== undefined
        ) return false;
        this.set({
            ...this.#state,
            error: undefined,
            notice: undefined,
            operations: {
                ...this.#state.operations,
                [operation]: "pending",
            },
        });
        try {
            await action(generation);
            if (!this.isCurrent(generation)) return false;
            if (refreshOverview) await this.#overview.refresh(generation, true);
            if (!this.isCurrent(generation)) return false;
            const { [operation]: _completed, ...operations } = this.#state.operations;
            this.set({ ...this.#state, notice: success, operations });
            return true;
        } catch (error) {
            if (!this.isCurrent(generation)) return false;
            const { [operation]: _failed, ...operations } = this.#state.operations;
            this.set({
                ...this.#state,
                error: errorMessage(error),
                operations,
            });
            return false;
        }
    }

    private clearScheduledRefreshes(): void {
        this.#instanceModels.clearScheduled();
        this.#overview.clearScheduled();
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
