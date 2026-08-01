import {
    ControlError,
    createError,
    errorCodes,
    type ConfigDraft,
    type ConfigInstancePatch,
    type ConfigMcpPatch,
    type ConfigWebPatch,
    type InstanceCreateDraft,
    type InstanceCreateSchema,
    type InstanceCreateSummary,
    type JsonValue
} from "@portable-devshell/shared";

import type { TuiClients } from "../client/TuiClientComposition.js";
import type { TuiControlSession } from "../control/TuiControlSession.js";
import { withTuiRequestTimeout } from "../control/TuiRequestTimeout.js";
import type { TuiPageId } from "../../state/TuiUiState.js";
import type { TuiAppStore } from "../../state/TuiAppStore.js";

export class TuiRuntimeControlOperations {
    constructor(private readonly options: {
        clients: TuiClients;
        operationTimeoutMs: number;
        reconnectDelayMs: number;
        session: TuiControlSession;
        store: TuiAppStore;
    }) {}

    async revokeArtifactShare(shareId: string): Promise<void> {
        await this.#request(this.options.clients.artifact.revokeShare(shareId), `artifact.revoke:${shareId}`);
        await this.#refreshBestEffort(this.#panelKey("instances"), async () => {
            await this.options.session.refreshArtifacts();
        });
    }

    async queueContextMessage(instance: string, ctxId: string, text: string): Promise<void> {
        const client = this.options.clients.contextMessage;
        if (client === undefined) throw new Error("Context message client is unavailable.");
        const message = await this.#request(
            client.queue(instance, { ctxId, text }),
            `contextMessage.queue:${instance}`
        );
        this.options.store.replaceContextMessages(instance, [message]);
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

    async applyConfig(): Promise<JsonValue> {
        const result = await this.#request(this.options.clients.config.apply(), "config.apply");
        await this.#refreshBestEffort(this.#panelKey("config"), async () => {
            await this.options.session.refresh();
        });
        return result;
    }

    async restartControl(): Promise<void> {
        await this.#request(this.options.clients.service.restart(), "service.restart");
        if (this.options.reconnectDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.options.reconnectDelayMs));
        }
        await this.#refreshBestEffort(this.#panelKey("connections"), async () => {
            await this.#request(this.options.session.reconnect(), "control.reconnect");
        });
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
        const snapshot = this.options.store.getState().snapshotsByInstance[instance];
        if (!enabled && snapshot?.daemonState !== undefined && snapshot.daemonState !== "stopped") {
            await this.#request(this.options.clients.runtime.stop(instance), `runtime.stop:${instance}`);
        }
        await this.#request(
            this.options.clients.config.updateInstance({
                instanceName: instance,
                patch: { enabled }
            }),
            `config.instance.enabled:${instance}`
        );
        await this.#request(this.options.clients.config.apply(), "config.apply");
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
        await this.#request(
            this.options.clients.mcp.decideApproval(approvalId, decision),
            `oauthApproval.${decision}:${approvalId}`
        );
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
        return await withTuiRequestTimeout(request, this.options.operationTimeoutMs, label);
    }

    #panelKey(page: TuiPageId): string {
        return `${page}:${this.options.store.getState().ui.selectedInstance ?? "-"}`;
    }
}

function toControlError(error: unknown): ControlError {
    if (error instanceof ControlError) return error;
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown } | undefined;
    return createError({
        code: typeof candidate?.code === "string" ? candidate.code : errorCodes.targetInvalid,
        message: typeof candidate?.message === "string" ? candidate.message : String(error),
        retryable: candidate?.retryable === true
    });
}
