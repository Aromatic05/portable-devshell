import {
    createError,
    errorMessage,
    toControlError,
    errorCodes,
    withRequestTimeout,
    type ConfigBatchUpdateRequest,
    type ConfigDraft,
    type ConfigInstancePatch,
    type ConfigMcpPatch,
    type ConfigWebPatch,
    type InstanceCreateDraft,
    type InstanceCreateSchema,
    type InstanceCreateSummary,
    type JsonValue
} from "@portable-devshell/shared";

import type {
    TuiRuntimeOperationClients,
    TuiRuntimeOperationSession,
} from "./TuiRuntimeOperationPorts.js";
import type { TuiPageId } from "../../state/TuiUiState.js";
import type { TuiAppStore } from "../../state/TuiAppStore.js";

export class TuiRuntimeControlOperations {
    constructor(private readonly options: {
        clients: TuiRuntimeOperationClients;
        operationTimeoutMs: number;
        reconnectDelayMs: number;
        session: TuiRuntimeOperationSession;
        store: TuiAppStore;
    }) {}

    async revokeArtifactShare(shareId: string): Promise<void> {
        await this.#request(this.options.clients.artifact.revokeShare(shareId), `artifact.revoke:${shareId}`);
        await this.#refreshBestEffort(this.#panelKey("instances"), async () => {
            await this.options.session.refreshArtifacts();
        });
    }

    async queueContextMessage(instance: string, ctxId: string, text: string): Promise<void> {
        await this.options.session.commands.queueContextMessage(instance, ctxId, text);
        await this.#refreshBestEffort(`audit:${instance}`, async () => {
            await this.options.session.refreshAudit(instance);
        });
    }

    async disableContext(instance: string, ctxId: string): Promise<void> {
        await this.options.session.commands.disableContext(ctxId);
        await this.#refreshBestEffort(`audit:${instance}`, async () => {
            await this.options.session.refreshAudit(instance);
        });
    }

    async renewContext(instance: string, ctxId: string): Promise<void> {
        await this.options.session.commands.renewContext(ctxId);
        await this.#refreshBestEffort(`audit:${instance}`, async () => {
            await this.options.session.refreshAudit(instance);
        });
    }

    async cancelArtifactTransfer(transferId: string): Promise<void> {
        await this.#request(
            this.options.clients.artifact.cancelTransfer(transferId),
            `artifact.cancel:${transferId}`
        );
        await this.#refreshBestEffort(this.#panelKey("instances"), async () => {
            await this.options.session.refreshArtifacts();
        });
    }

    async restartControl(): Promise<void> {
        await this.#request(this.options.clients.service.restart(), "service.restart");
        const errorKey = `${this.#panelKey("connections")}:operationRefresh`;
        const deadline = Date.now() + this.options.operationTimeoutMs;
        let lastError: unknown;

        while (Date.now() < deadline) {
            if (this.options.reconnectDelayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, this.options.reconnectDelayMs));
            }
            try {
                const remainingMs = Math.max(1, deadline - Date.now());
                await withRequestTimeout(
                    this.options.session.reconnect(),
                    remainingMs,
                    "control.reconnect"
                );
                this.options.store.setPanelError(errorKey, undefined);
                return;
            } catch (error) {
                lastError = error;
            }
        }

        const failure = createError({
            code: errorCodes.controlRestartFailed,
            message: `Control restart was accepted, but the replacement runtime did not become ready: ${errorMessage(lastError)}`,
            retryable: true
        });
        this.options.store.setPanelError(errorKey, failure);
        throw failure;
    }

    async createInstance(draft: InstanceCreateDraft): Promise<string | undefined> {
        const result = await this.#request(
            this.options.clients.instance.create(draft),
            `instance.create:${draft.name}`
        );
        let status: string | undefined;
        if (draft.provider === "reverse") {
            try {
                const code = await this.#request(
                    this.options.clients.reverse.createCode(result.name),
                    `reverse.code:${result.name}`
                );
                this.options.store.setPanelError(
                    `instances:${result.name}:enrollment`,
                    undefined
                );
                status = [
                    "Reverse instance created. Run:",
                    "devshell-worker enroll",
                    `--controller ${code.controllerUrl}`,
                    `--device-code ${code.deviceCode}`,
                    `(expires ${code.expiresAt})`
                ].join(" ");
            } catch (error) {
                const failure = toControlError(error);
                this.options.store.setPanelError(
                    `instances:${result.name}:enrollment`,
                    failure
                );
                status = [
                    `Reverse instance ${result.name} was created, but device code generation failed:`,
                    failure.message,
                    `Recover with: devshell instance device-code ${result.name}`
                ].join(" ");
            }
        }
        await this.#refreshBestEffort(`instances:${result.name}`, async () => {
            await this.options.session.refresh();
        });
        return status;
    }

    async getInstanceCreateSchema(): Promise<InstanceCreateSchema> {
        return await this.#request(this.options.clients.instance.createSchema(), "instance.createSchema");
    }

    async updateConfig(request: ConfigBatchUpdateRequest): Promise<JsonValue> {
        const result = await this.#request(this.options.clients.config.update(request), "config.update");
        await this.#refreshBestEffort(this.#panelKey("config"), async () => {
            await this.options.session.refreshConfig();
        });
        return result;
    }

    async updateInstanceConfig(instanceName: string, patch: ConfigInstancePatch): Promise<void> {
        await this.#request(
            this.options.clients.config.updateInstance({ instanceName, patch }),
            `config.instance.update:${instanceName}`
        );
    }

    async deleteInstance(instance: string): Promise<void> {
        await this.#request(this.options.clients.instance.delete(instance), `instance.delete:${instance}`);
        await this.#refreshBestEffort(`instances:${instance}`, async () => {
            await this.options.session.refresh();
        });
    }

    async setInstanceEnabled(instance: string, enabled: boolean): Promise<void> {
        const snapshot = this.options.store.getState().readModel.instanceState[instance]?.snapshot;
        const wasRunning = !enabled && snapshot?.daemonState !== undefined && snapshot.daemonState !== "stopped";
        let stoppedForDisable = false;
        try {
            if (wasRunning) {
                await this.options.session.commands.stopInstance(instance);
                stoppedForDisable = true;
            }
            await this.#request(
                this.options.clients.config.updateInstance({
                    instanceName: instance,
                    patch: { enabled }
                }),
                `config.instance.enabled:${instance}`
            );
        } catch (error) {
            if (stoppedForDisable) {
                try {
                    await this.options.session.commands.startInstance(instance);
                } catch (restoreError) {
                    throw new AggregateError(
                        [error, restoreError],
                        `Disabling ${instance} failed and the previous running state could not be restored.`
                    );
                }
            }
            throw error;
        }
        await this.#refreshBestEffort(`instances:${instance}`, async () => {
            await this.options.session.refresh();
        });
    }

    async updateMcpEndpoint(mcp: ConfigMcpPatch): Promise<void> {
        await this.#request(this.options.clients.config.updateMcpEndpoint({ patch: mcp }), "config.mcp.endpoint.update");
    }

    async updateWeb(web: ConfigWebPatch): Promise<void> {
        await this.#request(this.options.clients.config.updateWeb({ patch: web }), "config.web.update");
    }

    async decideOAuthApproval(approvalId: string, decision: "approve" | "deny"): Promise<void> {
        await this.options.session.commands.decideOAuthApproval(approvalId, decision);
        await this.#refreshBestEffort(this.#panelKey("connections"), async () => {
            await this.options.session.refreshOAuth();
        });
    }

    async validateConfigDraft(draft: ConfigDraft): Promise<void> {
        await this.#request(this.options.clients.config.validate(draft), "config.validate");
    }

    async validateInstanceCreateDraft(draft: InstanceCreateDraft): Promise<InstanceCreateSummary> {
        return await this.#request(
            this.options.clients.instance.validateCreate(draft),
            `instance.validateCreate:${draft.name}`
        );
    }

    async reloadLogs(): Promise<void> {
        await this.options.session.refreshLogs();
    }

    async reloadPage(page: TuiPageId, instance: string | undefined): Promise<void> {
        switch (page) {
            case "overview":
                await this.options.session.refreshOverview();
                return;
            case "instances":
            case "help":
                await this.options.session.refresh();
                return;
            case "terminal":
                return;
            case "todo":
                if (instance !== undefined) await this.options.session.refreshTodo(instance);
                return;
            case "config":
                await this.options.session.refreshConfig();
                return;
            case "connections":
                await this.options.session.refreshConfig();
                await this.options.session.refreshOAuth();
                return;
            case "audit":
                if (instance !== undefined) await this.options.session.refreshAudit(instance);
                return;
            case "logs":
                if (instance !== undefined) await this.options.session.refreshLogsForInstance(instance);
                return;
        }
    }

    async #refreshBestEffort(panelKey: string, refresh: () => Promise<void>): Promise<void> {
        const errorKey = `${panelKey}:operationRefresh`;
        try {
            await refresh();
            this.options.store.setPanelError(errorKey, undefined);
        } catch (error) {
            this.options.store.setPanelError(errorKey, toControlError(error));
        }
    }

    async #request<T>(request: Promise<T>, label: string): Promise<T> {
        return await withRequestTimeout(request, this.options.operationTimeoutMs, label, "uncertain");
    }

    #panelKey(page: TuiPageId): string {
        return `${page}:${this.options.store.getState().ui.selectedInstance ?? "-"}`;
    }
}
