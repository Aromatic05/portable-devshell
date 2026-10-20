import type {
    ConfigBatchUpdateRequest,
    ConfigDraft,
    MessagePreferencesPatch,
    InstanceCreateDraft,
    InstanceCreateSchema,
} from "@portable-devshell/shared";

import type { WebDomainSession } from "../app/domain/Session.js";
import { approvalOperationKey, WebOperationCoordinator } from "./Operation.js";
import { createInitialWebState, type WebState } from "./Model.js";
import { errorMessage, withRequestTimeout } from "./Request.js";

export type { WebState } from "./Model.js";

export interface WebStoreOptions {
    operationTimeoutMs?: number;
    requestTimeoutMs?: number;
}

export class WebStore {
    #state = createInitialWebState();
    readonly #listeners = new Set<() => void>();
    readonly #operations: WebOperationCoordinator;
    readonly #requestTimeoutMs: number;
    #messagePreferenceQueue = Promise.resolve();
    #controlRestartPromise?: Promise<boolean>;
    #loading?: Promise<void>;
    #auditRefresh?: Promise<void>;
    #generation = 0;
    #stopped = false;

    constructor(
        readonly domains: WebDomainSession,
        options: WebStoreOptions = {},
    ) {
        this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
        this.#operations = new WebOperationCoordinator(
            {
                getState: () => this.#state,
                isCurrent: (generation) => this.#current(generation),
                setState: (state) => this.#set(state),
            },
            options.operationTimeoutMs ?? 30_000,
        );
    }

    get state(): WebState {
        return this.#state;
    }

    operationFailure(operation: string): string | undefined {
        return this.#operations.failure(operation);
    }

    readonly subscribe = (listener: () => void): (() => void) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    };

    load(): Promise<void> {
        if (this.#stopped) return Promise.resolve();
        if (this.#loading !== undefined) return this.#loading;
        const loading = (async () => {
            try {
                await this.domains.load();
                if (this.#stopped) return;
                this.#set({ ...this.#state, error: undefined });
            } catch (error) {
                if (!this.#stopped)
                    this.#set({ ...this.#state, error: errorMessage(error) });
            }
        })();
        this.#loading = loading;
        void loading.finally(() => {
            if (this.#loading === loading) this.#loading = undefined;
        });
        return loading;
    }

    async reconnect(): Promise<void> {
        if (this.#stopped) return;
        this.#generation += 1;
        const generation = this.#generation;
        this.#operations.cancelAll(
            new Error("Web connection is reconnecting."),
        );
        this.#set({
            ...this.#state,
            error: undefined,
            notice: undefined,
            operations: {},
        });
        try {
            await withRequestTimeout(
                this.domains.reconnect(),
                this.#requestTimeoutMs,
                "control.reconnect",
            );
            if (this.#current(generation))
                this.#set({ ...this.#state, error: undefined });
        } catch (error) {
            if (this.#current(generation))
                this.#set({ ...this.#state, error: errorMessage(error) });
        }
    }

    async updateMessagePreferences(
        patch: MessagePreferencesPatch,
    ): Promise<boolean> {
        const generation = this.#generation;
        const run = async (): Promise<boolean> => {
            if (!this.#current(generation)) return false;
            try {
                await this.domains.messagePreferences.update(patch);
                return this.#current(generation);
            } catch (error) {
                if (this.#current(generation))
                    this.#set({
                        ...this.#state,
                        error: errorMessage(error),
                        notice: undefined,
                    });
                return false;
            }
        };
        const request = this.#messagePreferenceQueue.then(run, run);
        this.#messagePreferenceQueue = request.then(
            () => undefined,
            () => undefined,
        );
        return await request;
    }

    async refreshToolCall(instance: string): Promise<void> {
        const runtime = this.domains.runtime(instance);
        await Promise.all([
            this.domains.toolCalls.load(instance),
            runtime.load().then(() => runtime.readLogs()),
        ]);
    }

    async refreshAudit(): Promise<void> {
        if (this.#auditRefresh !== undefined) return this.#auditRefresh;
        const refresh = this.#refreshAudit();
        this.#auditRefresh = refresh;
        try {
            await refresh;
        } finally {
            if (this.#auditRefresh === refresh) this.#auditRefresh = undefined;
        }
    }

    async #refreshAudit(): Promise<void> {
        // An online socket is not the same as a fully loaded instance catalog.
        // A concurrent catalog read can supersede this one and leave Audit empty.
        await this.#loading;
        await Promise.all([
            this.domains.instances.refresh(),
            this.domains.context.refresh(),
        ]);
        const instances = this.domains.instances.state.instances.map(
            ({ name }) => name,
        );
        await Promise.all(
            instances.map(async (instance) => {
                const runtime = this.domains.runtime(instance);
                await Promise.all([
                    runtime.load().then(() => runtime.readLogs()),
                    this.domains.approval(instance).load(),
                    this.domains.toolCalls.load(instance),
                    this.domains.messageHistory.refreshInstance(instance),
                    this.domains.messages.refreshInstance(instance),
                ]);
            }),
        );
    }

    async refreshMessages(): Promise<void> {
        await Promise.all([
            this.domains.instances.refresh(),
            this.domains.context.refresh(),
        ]);
        const instances = this.domains.instances.state.instances.map(
            ({ name }) => name,
        );
        await Promise.all([
            this.domains.messageHistory.load(instances),
            this.domains.messagePreferences.refresh(),
            this.domains.messages.load(instances),
        ]);
    }

    async decideTool(
        instance: string,
        approvalId: string,
        decision: "approve" | "deny",
    ): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            approvalOperationKey(instance, approvalId),
            "Approval recorded.",
            generation,
            async () => {
                const approval = this.domains.approval(instance);
                await approval.load();
                await approval.decide(approvalId, decision);
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
            async () => {
                await this.domains.messages.queue(instance, ctxId, text);
            },
        );
    }

    async disableContext(ctxId: string): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `context-disable:${ctxId}`,
            "Context disabled.",
            generation,
            async () => {
                await this.domains.context.disable(ctxId);
            },
        );
    }

    async disableContexts(ctxIds: readonly string[]): Promise<boolean> {
        const ids = [...new Set(ctxIds)].filter(Boolean);
        if (ids.length === 0) return true;
        const generation = this.#generation;
        return await this.#operations.run(
            "context-disable-batch",
            `${ids.length} Context${ids.length === 1 ? "" : "s"} disabled.`,
            generation,
            async () => {
                const failures: string[] = [];
                for (const ctxId of ids) {
                    try {
                        await this.domains.context.disable(ctxId);
                    } catch (error) {
                        failures.push(`${ctxId}: ${errorMessage(error)}`);
                    }
                }
                if (failures.length > 0)
                    throw new Error(`Failed to disable ${failures.join("; ")}`);
            },
        );
    }

    async renewContext(ctxId: string): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `context-renew:${ctxId}`,
            "Context renewed.",
            generation,
            async () => {
                await this.domains.context.renew(ctxId);
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
                const todo = this.domains.todo(instance);
                await todo.load();
                await todo.delete(taskId);
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
                const runtime = this.domains.runtime(instance);
                await runtime.load();
                await runtime.stop();
                if (signal.aborted || !this.#current(generation)) return;
                await runtime.start({ signal });
            },
        );
    }

    async setInstanceEnabled(
        instance: string,
        enabled: boolean,
    ): Promise<boolean> {
        const generation = this.#generation;
        let cleanupNotice: string | undefined;
        const succeeded = await this.#operations.run(
            "enabled:" + instance,
            instance + (enabled ? " enabled." : " disabled."),
            generation,
            async () => {
                const result = enabled
                    ? await this.domains.instances.enable(instance)
                    : await this.domains.instances.disable(instance);
                if (result?.cleanupPending === true)
                    cleanupNotice = instance + " configuration committed; lifecycle cleanup is still pending.";
            },
        );
        if (succeeded && cleanupNotice !== undefined && this.#current(generation))
            this.#set({ ...this.#state, notice: cleanupNotice });
        return succeeded;
    }

    async deleteInstance(instance: string): Promise<boolean> {
        const generation = this.#generation;
        let cleanupNotice: string | undefined;
        const succeeded = await this.#operations.run(
            `delete:${instance}`,
            `${instance} deleted.`,
            generation,
            async () => {
                const result = await this.domains.instances.delete(instance);
                if (result?.cleanupPending === true) {
                    cleanupNotice = `${instance} deregistered, but lifecycle cleanup is still pending. Review Control logs before reusing this name.`;
                } else if (
                    Array.isArray(result?.cleanupWarnings) &&
                    result.cleanupWarnings.length > 0
                ) {
                    cleanupNotice = `${instance} deregistered; remote provider resources could not be fully removed.`;
                }
                this.domains.releaseInstance(instance);
            },
        );
        if (
            succeeded &&
            cleanupNotice !== undefined &&
            this.#current(generation)
        )
            this.#set({ ...this.#state, notice: cleanupNotice });
        return succeeded;
    }

    async revokeArtifactShare(shareId: string): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `artifact:revoke:${shareId}`,
            `Artifact share ${shareId} revoked.`,
            generation,
            async () => {
                await this.domains.artifact.revokeShare(shareId);
            },
        );
    }

    async cancelArtifactTransfer(transferId: string): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            `artifact:cancel:${transferId}`,
            `Artifact transfer ${transferId} cancellation requested.`,
            generation,
            async () => {
                await this.domains.artifact.cancelTransfer(transferId);
            },
        );
    }

    async getInstanceCreateSchema(): Promise<InstanceCreateSchema> {
        return await withRequestTimeout(
            this.domains.instances.createSchema(),
            this.#requestTimeoutMs,
            "instance.createSchema",
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
            async () => {
                const result = await this.domains.instances.create(draft);
                await this.domains.instances.refresh();
                if (draft.provider === "reverse") {
                    try {
                        const code = await this.domains.reverse.createCode(
                            result.name,
                        );
                        enrollment = [
                            "devshell-worker enroll",
                            `--controller ${code.controllerUrl}`,
                            `--device-code ${code.deviceCode}`,
                        ].join(" ");
                        enrollment += `\nCode expires: ${code.expiresAt}\nIf pairing fails, open this instance's Connections page to create a new code. Do not recreate the instance.`;
                    } catch (error) {
                        enrollment = [
                            `Reverse instance ${result.name} was created, but device code generation failed:`,
                            errorMessage(error),
                            `Recover with: devshell instance device-code ${result.name}`,
                        ].join(" ");
                    }
                }
            },
        );
        return {
            ...(enrollment === undefined ? {} : { enrollment }),
            succeeded,
        };
    }

    async validateConfig(draft: ConfigDraft): Promise<boolean> {
        return await this.#operations.run(
            "config:validate",
            "Configuration is valid.",
            this.#generation,
            async () => {
                await withRequestTimeout(
                    this.domains.config.validate(draft),
                    this.#requestTimeoutMs,
                    "config.validate",
                );
            },
        );
    }

    async updateConfig(request: ConfigBatchUpdateRequest): Promise<boolean> {
        const generation = this.#generation;
        return await this.#operations.run(
            "config:update",
            "Configuration saved.",
            generation,
            async () => {
                await this.domains.config.update(request);
                if (request.mcp !== undefined) await this.domains.mcp.refresh();
            },
        );
    }

    async createReverseCode(instance: string): Promise<string | undefined> {
        try {
            const result = await withRequestTimeout(
                this.domains.reverse.createCode(instance),
                this.#requestTimeoutMs,
                `reverse.createCode:${instance}`,
            );
            return (
                [
                    "devshell-worker enroll",
                    `--controller ${result.controllerUrl}`,
                    `--device-code ${result.deviceCode}`,
                ].join(" ") +
                `\nCode expires: ${result.expiresAt}\nIf the code expires or was consumed, generate another here.`
            );
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
                await this.domains.reverse.rotateToken(instance);
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
                await this.domains.reverse.revokeToken(instance);
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
        this.#operations.cancelAll(new Error("Web store closed."));
        this.domains.close();
        this.#listeners.clear();
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
                const runtime = this.domains.runtime(instance);
                await runtime.load();
                if (action === "start") await runtime.start({ signal });
                else await runtime.stop();
            },
        );
    }

    async #restartControl(): Promise<boolean> {
        try {
            await withRequestTimeout(
                this.domains.server.restart(),
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
            try {
                await this.domains.reconnect();
                if (this.domains.server.state.status === "online") {
                    this.#set({
                        ...this.#state,
                        error: undefined,
                        notice: "Control runtime restarted.",
                    });
                    return true;
                }
            } catch (error) {
                lastError = errorMessage(error);
            }
        }
        this.#set({
            ...this.#state,
            error: `Control restart was accepted, but the replacement runtime did not become ready: ${lastError}`,
            notice: undefined,
        });
        return false;
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
