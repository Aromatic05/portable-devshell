import {
    ControlCommands,
    ControlReadModel,
    ControlRefreshScheduler,
    errorMessage,
    withRequestTimeout,
    type ConfigBatchUpdateRequest,
    type ConfigDraft,
    type ConfigInstancePatch,
    type ConfigMcpPatch,
    type ConfigWebPatch,
    type ConversationPreferencesPatch,
    type InstanceCreateDraft,
    type InstanceCreateSchema,
    type InstanceCreateSummary,
} from "@portable-devshell/shared/browser";

import type { WebClients } from "../app/transport/Client.js";
import { WebOperationCoordinator } from "./Operation.js";
import { createInitialWebState, webFailures, type WebState } from "./Model.js";

export type { ConnectionState, WebState } from "./Model.js";

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
    readonly #listeners = new Set<() => void>();
    readonly #model: ControlReadModel;
    readonly #commands: ControlCommands;
    readonly #operations: WebOperationCoordinator;
    readonly #requestTimeoutMs: number;
    readonly #offTransportClose: () => void;
    readonly #refreshScheduler: ControlRefreshScheduler;
    #stopped = false;
    #loadPromise?: Promise<void>;
    #reconnectPromise?: Promise<void>;
    #controlRestartPromise?: Promise<boolean>;
    #conversationPreferenceQueue = Promise.resolve();
    #generation = 0;
    #ignoreTransportClose = false;
    #overviewActive = false;

    constructor(
        readonly clients: WebClients,
        options: WebStoreOptions = {},
    ) {
        this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
        const isPageVisible =
            options.isPageVisible ??
            (() =>
                typeof document === "undefined" ||
                document.visibilityState !== "hidden");
        this.#operations = new WebOperationCoordinator(
            {
                getState: () => this.#state,
                isCurrent: (generation) => this.#current(generation),
                setState: (state) => this.#set(state),
            },
            options.operationTimeoutMs ?? 30_000,
        );
        this.#model = new ControlReadModel({
            clients,
            onEvent: (event) => {
                if (event.type !== "log.appended")
                    this.#refreshScheduler.scheduleOverview(250);
            },
            requestTimeoutMs: this.#requestTimeoutMs,
            retryBaseMs: options.streamRetryBaseMs,
            stableAfterMs: options.streamStableAfterMs,
        });
        this.#commands = new ControlCommands({
            clients,
            model: this.#model,
            timeoutMs: options.operationTimeoutMs ?? 30_000,
        });
        this.#refreshScheduler = new ControlRefreshScheduler({
            model: this.#model,
            overviewIntervalMs: options.overviewRefreshIntervalMs,
            shouldRefreshOAuth: () => {
                const status = this.#model.state.mcpStatus;
                return (
                    this.#listeners.size > 0 &&
                    this.#state.connection === "online" &&
                    isPageVisible() &&
                    status?.authMode === "oauth2" &&
                    status.oauthReady === true &&
                    status.running === true
                );
            },
            shouldRefreshOverview: () =>
                this.#listeners.size > 0 &&
                this.#state.connection === "online" &&
                isPageVisible() &&
                this.#overviewActive,
        });
        this.#refreshScheduler.start();
        this.#model.subscribe(() => this.#syncModel());
        this.#offTransportClose = clients.onTransportClose((error) =>
            this.#transportClosed(error),
        );
    }

    get state(): WebState {
        return this.#state;
    }

    readonly subscribe = (listener: () => void): (() => void) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    };

    setOverviewActive(active: boolean): void {
        if (this.#overviewActive === active) return;
        this.#overviewActive = active;
        if (active) this.#refreshScheduler.scheduleOverview(0);
    }

    async load(): Promise<void> {
        if (this.#stopped) return;
        if (this.#loadPromise !== undefined) return await this.#loadPromise;
        const generation = this.#generation;
        this.#set({
            ...this.#state,
            connection: "connecting",
            error: undefined,
        });
        const request = this.#model
            .load({ artifacts: true, config: true })
            .then(
                async () => {
                    if (!this.#current(generation)) return;
                    await this.#loadConversationPreferences(generation);
                    if (this.#current(generation)) {
                        this.#set({
                            ...this.#state,
                            connection: "online",
                            error: undefined,
                        });
                    }
                },
                (error: unknown) => {
                    if (this.#current(generation)) {
                        this.#set({
                            ...this.#state,
                            connection: "offline",
                            error: errorMessage(error),
                        });
                    }
                },
            )
            .finally(() => {
                if (this.#loadPromise === request)
                    this.#loadPromise = undefined;
            });
        this.#loadPromise = request;
        return await request;
    }

    async updateConversationPreferences(
        patch: ConversationPreferencesPatch,
    ): Promise<boolean> {
        const generation = this.#generation;
        const run = async (): Promise<boolean> => {
            if (!this.#current(generation)) return false;
            try {
                const preferences = await withRequestTimeout(
                    this.clients.conversation.updatePreferences(patch),
                    this.#requestTimeoutMs,
                    "conversation.updatePreferences",
                );
                if (!this.#current(generation)) return false;
                this.#set({
                    ...this.#state,
                    conversationPreferences: preferences,
                    conversationPreferencesError: undefined,
                });
                return true;
            } catch (error) {
                if (this.#current(generation)) {
                    this.#set({
                        ...this.#state,
                        conversationPreferencesError: errorMessage(error),
                    });
                }
                return false;
            }
        };
        const request = this.#conversationPreferenceQueue.then(run, run);
        this.#conversationPreferenceQueue = request.then(
            () => undefined,
            () => undefined,
        );
        return await request;
    }

    async reconnect(): Promise<void> {
        if (this.#reconnectPromise !== undefined)
            return await this.#reconnectPromise;
        const request = this.#reconnect().finally(() => {
            if (this.#reconnectPromise === request)
                this.#reconnectPromise = undefined;
        });
        this.#reconnectPromise = request;
        return await request;
    }

    async refreshInstance(name: string): Promise<void> {
        await this.#model.refreshInstance(name, ["snapshot"]);
        const failures = webFailures(this.#model.state);
        const errors = [failures[`instance:${name}`]].filter(
            (value): value is string => value !== undefined,
        );
        if (errors.length > 0) throw new Error(errors.join("; "));
    }

    async refreshToolCall(instance: string): Promise<void> {
        await this.#model.refreshInstance(instance, ["toolCalls", "logs"]);
        const failures = webFailures(this.#model.state);
        const errors = [
            failures[`toolCalls:${instance}`],
            failures[`logs:${instance}`],
        ].filter((value): value is string => value !== undefined);
        if (errors.length > 0) throw new Error(errors.join("; "));
    }

    async readToolCallDetail(instance: string, callId: string) {
        return await this.#model.readToolCallDetail(instance, callId);
    }

    async refreshAudit(): Promise<void> {
        await Promise.all([
            this.#model.refreshInstances(),
            this.#model.refreshContexts(),
        ]);
        await Promise.all(
            this.#model.state.instances.map(async ({ name }) => {
                await this.#model.refreshInstance(name, [
                    "toolCalls",
                    "comments",
                    "logs",
                ]);
            }),
        );
    }

    async refreshMessages(): Promise<void> {
        const generation = this.#generation;
        await Promise.all([
            this.#model.refreshContexts(),
            ...this.#model.state.instances.map(async ({ name }) => {
                await this.#model.refreshInstance(name, ["comments"]);
            }),
            this.#loadConversationPreferences(generation),
        ]);
    }

    readonly readArtifactImage = async (imageRef: string) =>
        await withRequestTimeout(
            this.clients.artifact.readImage(imageRef),
            this.#requestTimeoutMs,
            "artifact.readImage",
        );

    async decideTool(
        instance: string,
        approvalId: string,
        decision: "approve" | "deny",
    ): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `approval:${approvalId}`,
            "Approval recorded.",
            generation,
            async (signal) => {
                await this.#commands.decideToolApproval(
                    instance,
                    approvalId,
                    decision,
                );
                if (signal.aborted || !this.#current(generation)) return;
            },
        );
    }

    async decideOAuth(
        approvalId: string,
        decision: "approve" | "deny",
    ): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `oauth:${approvalId}`,
            "Approval recorded.",
            generation,
            async (signal) => {
                await this.#commands.decideOAuthApproval(approvalId, decision);
                if (signal.aborted || !this.#current(generation)) return;
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
            async (_signal) => {
                await this.#commands.queueContextMessage(instance, ctxId, text);
            },
        );
    }

    async disableContext(ctxId: string): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `context-disable:${ctxId}`,
            "Context disabled.",
            generation,
            async (signal) => {
                await this.#commands.disableContext(ctxId);
                if (signal.aborted || !this.#current(generation)) return;
            },
        );
    }

    async disableContexts(ctxIds: readonly string[]): Promise<boolean> {
        const uniqueCtxIds = [...new Set(ctxIds)].filter(
            (ctxId) => ctxId.length > 0,
        );
        if (uniqueCtxIds.length === 0) return true;
        const generation = this.#generation;
        return await this.#operations.run(
            "context-disable-batch",
            `${uniqueCtxIds.length} Context${uniqueCtxIds.length === 1 ? "" : "s"} disabled.`,
            generation,
            async (signal) => {
                if (signal.aborted || !this.#current(generation)) return;
                const results = await Promise.all(
                    uniqueCtxIds.map(async (ctxId) => {
                        try {
                            await withRequestTimeout(
                                this.clients.context.disable(ctxId),
                                this.#requestTimeoutMs,
                                `context.disable:${ctxId}`,
                            );
                            return undefined;
                        } catch (error) {
                            return `${ctxId}: ${errorMessage(error)}`;
                        }
                    }),
                );
                const failures = results.filter(
                    (result): result is string => result !== undefined,
                );
                if (signal.aborted || !this.#current(generation)) return;
                if (this.#current(generation))
                    await this.#model.refreshContexts();
                if (failures.length > 0) {
                    throw new Error(`Failed to disable ${failures.join("; ")}`);
                }
            },
        );
    }

    async renewContext(ctxId: string): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `context-renew:${ctxId}`,
            "Context renewed.",
            generation,
            async (signal) => {
                await this.#commands.renewContext(ctxId);
                if (signal.aborted || !this.#current(generation)) return;
            },
        );
    }

    async deleteTodo(instance: string, taskId: string): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `todo-delete:${instance}:${taskId}`,
            "Todo project deleted.",
            generation,
            async () => {
                await this.clients.todo.delete(instance, taskId);
                if (this.#current(generation))
                    await this.#model.refreshInstance(instance, ["todo"]);
            },
        );
    }

    async start(instance: string): Promise<boolean> {
        return await this.#lifecycle(instance, "start");
    }

    async stop(instance: string): Promise<boolean> {
        return await this.#lifecycle(instance, "stop");
    }

    async restart(instance: string): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `restart:${instance}`,
            `${instance} restart requested.`,
            generation,
            async (signal) => {
                await this.#commands.stopInstance(instance);
                if (signal.aborted || !this.#current(generation)) return;
                await this.#commands.startInstance(instance, { signal });
            },
        );
    }

    async setInstanceEnabled(
        instance: string,
        enabled: boolean,
    ): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `enabled:${instance}`,
            `${instance} ${enabled ? "enabled" : "disabled"}.`,
            generation,
            async (signal) => {
                if (enabled) await this.clients.instance.enable(instance);
                else await this.clients.instance.disable(instance);
                if (signal.aborted || !this.#current(generation)) return;
                await this.#model.refreshControl();
            },
        );
    }

    async deleteInstance(instance: string): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `delete:${instance}`,
            `${instance} deleted.`,
            generation,
            async (signal) => {
                await this.clients.instance.delete(instance);
                if (signal.aborted || !this.#current(generation)) return;
                await this.#model.refreshControl();
            },
        );
    }

    async refreshArtifacts(): Promise<void> {
        await this.#model.refreshArtifacts();
        const failure = webFailures(this.#model.state).artifacts;
        if (failure !== undefined) throw new Error(failure);
    }

    async revokeArtifactShare(shareId: string): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `artifact:revoke:${shareId}`,
            `Artifact share ${shareId} revoked.`,
            generation,
            async (signal) => {
                await this.clients.artifact.revokeShare(shareId);
                if (signal.aborted || !this.#current(generation)) return;
                await this.#model.refreshArtifacts();
            },
        );
    }

    async cancelArtifactTransfer(transferId: string): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `artifact:cancel:${transferId}`,
            `Artifact transfer ${transferId} cancellation requested.`,
            generation,
            async (signal) => {
                await this.clients.artifact.cancelTransfer(transferId);
                if (signal.aborted || !this.#current(generation)) return;
                await this.#model.refreshArtifacts();
            },
        );
    }

    async getInstanceCreateSchema(): Promise<InstanceCreateSchema> {
        return await withRequestTimeout(
            this.clients.instance.createSchema(),
            this.#requestTimeoutMs,
            "instance.createSchema",
        );
    }

    async validateInstanceCreate(
        draft: InstanceCreateDraft,
    ): Promise<InstanceCreateSummary> {
        return await withRequestTimeout(
            this.clients.instance.validateCreate(draft),
            this.#requestTimeoutMs,
            `instance.validateCreate:${draft.name}`,
        );
    }

    async createInstance(draft: InstanceCreateDraft): Promise<{
        enrollment?: string;
        succeeded: boolean;
    }> {
        const generation = this.#generation;
        let enrollment: string | undefined;
        const succeeded = await this.#operations.run(
            `instance-create:${draft.name || "new"}`,
            `${draft.name || "Instance"} created.`,
            generation,
            async (signal) => {
                const result = await this.clients.instance.create(draft);
                if (signal.aborted || !this.#current(generation)) return;
                if (draft.provider === "reverse") {
                    try {
                        const code = await this.clients.reverse.createCode(
                            result.name,
                        );
                        enrollment = [
                            "devshell-worker enroll",
                            `--controller ${code.controllerUrl}`,
                            `--device-code ${code.deviceCode}`,
                            `(expires ${code.expiresAt})`,
                        ].join(" ");
                    } catch (error) {
                        enrollment = [
                            `Reverse instance ${result.name} was created, but device code generation failed:`,
                            errorMessage(error),
                            `Recover with: devshell instance device-code ${result.name}`,
                        ].join(" ");
                    }
                }
                if (signal.aborted || !this.#current(generation)) return;
                await this.#model.refreshControl();
            },
        );
        return {
            ...(enrollment === undefined ? {} : { enrollment }),
            succeeded,
        };
    }

    async refreshConfig(): Promise<void> {
        await this.#model.refreshConfig();
        const failure = webFailures(this.#model.state).config;
        if (failure !== undefined) throw new Error(failure);
    }

    async validateConfig(draft: ConfigDraft): Promise<boolean> {
        try {
            await withRequestTimeout(
                this.clients.config.validate(draft),
                this.#requestTimeoutMs,
                "config.validate",
            );
            return true;
        } catch (error) {
            this.#set({
                ...this.#state,
                error: errorMessage(error),
                notice: undefined,
            });
            return false;
        }
    }

    async updateConfig(request: ConfigBatchUpdateRequest): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            "config:update",
            "Configuration saved.",
            generation,
            async (signal) => {
                await this.clients.config.update(request);
                if (signal.aborted || !this.#current(generation)) return;
                await this.#model.refreshConfig();
                await this.#model.refreshMcp();
            },
        );
    }

    async updateInstanceConfig(
        instance: string,
        patch: ConfigInstancePatch,
    ): Promise<boolean> {
        return await this.updateConfig({
            instance: { instanceName: instance, patch },
        });
    }

    async updateMcpConfig(patch: ConfigMcpPatch): Promise<boolean> {
        return await this.updateConfig({ mcp: patch });
    }

    async updateWebConfig(patch: ConfigWebPatch): Promise<boolean> {
        return await this.updateConfig({ web: patch });
    }

    async decideOAuthApproval(
        approvalId: string,
        decision: "approve" | "deny",
    ): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `oauth:${decision}:${approvalId}`,
            `OAuth request ${decision === "approve" ? "approved" : "denied"}.`,
            generation,
            async (signal) => {
                await this.clients.mcp.decideApproval(approvalId, decision);
                if (signal.aborted || !this.#current(generation)) return;
                this.#model.recordOAuthDecision(approvalId);
                await this.#model.refreshMcp();
            },
        );
    }

    async createReverseCode(instance: string): Promise<string | undefined> {
        try {
            const result = await withRequestTimeout(
                this.clients.reverse.createCode(instance),
                this.#requestTimeoutMs,
                `reverse.createCode:${instance}`,
            );
            return [
                "devshell-worker enroll",
                `--controller ${result.controllerUrl}`,
                `--device-code ${result.deviceCode}`,
                `(expires ${result.expiresAt})`,
            ].join(" ");
        } catch (error) {
            this.#set({
                ...this.#state,
                error: errorMessage(error),
                notice: undefined,
            });
            return undefined;
        }
    }

    async rotateReverseToken(instance: string): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `reverse:rotate:${instance}`,
            `${instance} device token rotated.`,
            generation,
            async () => {
                await this.clients.reverse.rotateToken(instance);
            },
        );
    }

    async revokeReverseToken(instance: string): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `reverse:revoke:${instance}`,
            `${instance} device token revoked.`,
            generation,
            async () => {
                await this.clients.reverse.revokeToken(instance);
            },
        );
    }

    async restartControl(): Promise<boolean> {
        if (this.#controlRestartPromise !== undefined)
            return await this.#controlRestartPromise;
        const request = this.#restartControl().finally(() => {
            if (this.#controlRestartPromise === request)
                this.#controlRestartPromise = undefined;
        });
        this.#controlRestartPromise = request;
        return await request;
    }

    dismissFeedback(kind: "error" | "notice"): void {
        if (kind === "error") {
            if (this.#state.error === undefined) return;
            this.#set({ ...this.#state, error: undefined });
            return;
        }
        if (this.#state.notice === undefined) return;
        this.#set({ ...this.#state, notice: undefined });
    }

    close(): void {
        if (this.#stopped) return;
        this.#stopped = true;
        this.#generation += 1;
        this.#offTransportClose();
        this.#operations.cancelAll(new Error("Web store closed."));
        this.#commands.reset();
        this.#refreshScheduler.stop();
        this.#model.close();
        this.clients.close();
    }

    async #lifecycle(
        instance: string,
        action: "start" | "stop",
    ): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `${action}:${instance}`,
            `${instance} ${action} requested.`,
            generation,
            async (signal) => {
                if (action === "start") {
                    await this.#commands.startInstance(instance, { signal });
                } else {
                    await this.#commands.stopInstance(instance);
                }
            },
        );
    }

    async #loadConversationPreferences(generation: number): Promise<void> {
        try {
            const preferences = await withRequestTimeout(
                this.clients.conversation.preferences(),
                this.#requestTimeoutMs,
                "conversation.preferences",
            );
            if (!this.#current(generation)) return;
            this.#set({
                ...this.#state,
                conversationPreferences: preferences,
                conversationPreferencesError: undefined,
            });
        } catch (error) {
            if (!this.#current(generation)) return;
            this.#set({
                ...this.#state,
                conversationPreferences: undefined,
                conversationPreferencesError: errorMessage(error),
            });
        }
    }

    async #reconnect(): Promise<void> {
        this.#generation += 1;
        const generation = this.#generation;
        this.#operations.cancelAll(
            new Error("Web connection is reconnecting."),
        );
        this.#commands.reset();
        this.#model.reset();
        this.#set({
            ...this.#state,
            connection: "connecting",
            conversationPreferencesError: undefined,
            error: undefined,
            notice: undefined,
            operations: {},
        });
        this.#ignoreTransportClose = true;
        try {
            await withRequestTimeout(
                this.clients.reconnect(),
                this.#requestTimeoutMs,
                "control.reconnect",
            );
        } catch (error) {
            if (this.#current(generation)) {
                this.#set({
                    ...this.#state,
                    connection: "offline",
                    error: errorMessage(error),
                });
            }
            return;
        } finally {
            this.#ignoreTransportClose = false;
        }
        if (this.#current(generation)) await this.load();
    }

    async #restartControl(): Promise<boolean> {
        try {
            await withRequestTimeout(
                this.clients.service.restart(),
                this.#requestTimeoutMs,
                "control.restart",
            );
        } catch (error) {
            this.#set({
                ...this.#state,
                error: errorMessage(error),
                notice: undefined,
            });
            return false;
        }
        let lastError = "replacement runtime is not ready";
        const deadline = Date.now() + 30_000;
        while (!this.#stopped && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            await this.reconnect();
            if (this.#state.connection === "online") {
                this.#set({
                    ...this.#state,
                    error: undefined,
                    notice: "Control runtime restarted.",
                });
                return true;
            }
            lastError = this.#state.error ?? lastError;
        }
        this.#set({
            ...this.#state,
            error: `Control restart was accepted, but the replacement runtime did not become ready: ${lastError}`,
            notice: undefined,
        });
        return false;
    }

    #syncModel(): void {
        if (this.#stopped) return;
        this.#set({ ...this.#state, readModel: this.#model.state });
    }

    #transportClosed(error: Error): void {
        if (this.#stopped || this.#ignoreTransportClose) return;
        this.#generation += 1;
        this.#operations.cancelAll(error);
        this.#commands.reset();
        this.#model.reset();
        this.#set({
            ...this.#state,
            connection: "offline",
            error: error.message,
            notice: undefined,
            operations: {},
        });
    }

    #current(generation: number): boolean {
        return !this.#stopped && this.#generation === generation;
    }

    #set(state: WebState): void {
        if (this.#stopped) return;
        this.#state = state;
        for (const listener of this.#listeners) listener();
    }
}
