import {
    createRemoteError,
    errorMessage,
    toRemoteError,
    controlErrorCodes,
    withRequestTimeout,
    type ConfigBatchUpdateRequest,
    type ConfigDraft,
    type ConfigInstancePatch,
    type ConfigMcpPatch,
    type ConfigWebPatch,
    type InstanceCreateDraft,
    type InstanceCreateSchema,
    type InstanceCreateSummary,
    type JsonValue,
} from "@portable-devshell/shared";

import type { TuiRuntimeOperationContext } from "../Operations.js";
import {
    refreshTuiAll,
    refreshTuiAudit,
    refreshTuiMessages,
    refreshTuiGoals,
} from "../control/Refresh.js";
import type { TuiPageId } from "../../state/Ui.js";
import type { TuiAppStore } from "../../state/store/App.js";

export class TuiRuntimeControlOperations {
    constructor(
        private readonly options: TuiRuntimeOperationContext & {
            operationTimeoutMs: number;
            reconnectDelayMs: number;
            store: TuiAppStore;
        },
    ) {}

    async revokeArtifactShare(shareId: string): Promise<void> {
        await this.#request(
            this.options.clients.artifact.revokeShare(shareId),
            `artifact.revoke:${shareId}`,
        );
        await this.#refreshBestEffort(this.#panelKey("instances"), async () => {
            await this.options.domains.artifact.refresh();
        });
    }

    async queueContextMessage(
        instance: string,
        ctxId: string,
        text: string,
    ): Promise<void> {
        await this.options.domains.messages.queue(instance, ctxId, text);
        await this.#refreshBestEffort(`audit:${instance}`, async () => {
            await refreshTuiAudit(this.options.domains, instance);
        });
    }

    async disableContext(instance: string, ctxId: string): Promise<void> {
        await this.options.domains.context.disable(ctxId);
        await this.#refreshBestEffort(`audit:${instance}`, async () => {
            await refreshTuiAudit(this.options.domains, instance);
        });
    }

    async renewContext(instance: string, ctxId: string): Promise<void> {
        await this.options.domains.context.renew(ctxId);
        await this.#refreshBestEffort(`audit:${instance}`, async () => {
            await refreshTuiAudit(this.options.domains, instance);
        });
    }

    async cancelArtifactTransfer(transferId: string): Promise<void> {
        await this.#request(
            this.options.clients.artifact.cancelTransfer(transferId),
            `artifact.cancel:${transferId}`,
        );
        await this.#refreshBestEffort(this.#panelKey("instances"), async () => {
            await this.options.domains.artifact.refresh();
        });
    }

    async restartControl(): Promise<void> {
        await this.#request(
            this.options.clients.server.restart(),
            "server.restart",
        );
        const errorKey = `${this.#panelKey("connections")}:operationRefresh`;
        const deadline = Date.now() + this.options.operationTimeoutMs;
        let lastError: unknown;

        while (Date.now() < deadline) {
            if (this.options.reconnectDelayMs > 0) {
                await new Promise((resolve) =>
                    setTimeout(resolve, this.options.reconnectDelayMs),
                );
            }
            try {
                const remainingMs = Math.max(1, deadline - Date.now());
                await withRequestTimeout(
                    this.options.reconnect(),
                    remainingMs,
                    "control.reconnect",
                );
                this.options.store.setPanelError(errorKey, undefined);
                return;
            } catch (error) {
                lastError = error;
            }
        }

        const failure = createRemoteError({
            code: controlErrorCodes.restartFailed,
            message: `Control restart was accepted, but the replacement runtime did not become ready: ${errorMessage(lastError)}`,
            retryable: true,
        });
        this.options.store.setPanelError(errorKey, failure);
        throw failure;
    }

    async createReverseCode(
        instance: string,
    ): Promise<import("@portable-devshell/shared").ReverseDeviceCodeResult> {
        return await this.#request(
            this.options.clients.reverse.createCode(instance),
            `reverse.createCode:${instance}`,
        );
    }

    async revokeReverseToken(instance: string): Promise<void> {
        await this.#request(
            this.options.clients.reverse.revokeToken(instance),
            `reverse.revokeToken:${instance}`,
        );
        await this.#refreshBestEffort(`connections:${instance}`, async () => {
            await this.options.domains.runtime(instance).load();
        });
    }

    async createInstance(
        draft: InstanceCreateDraft,
    ): Promise<string | undefined> {
        const result = await this.#request(
            this.options.clients.instance.createInstance(draft),
            `instance.create:${draft.name}`,
        );
        let status: string | undefined;
        if (draft.provider === "reverse") {
            try {
                const code = await this.#request(
                    this.options.clients.reverse.createCode(result.name),
                    `reverse.code:${result.name}`,
                );
                this.options.store.setPanelError(
                    `instances:${result.name}:enrollment`,
                    undefined,
                );
                status =
                    [
                        "Reverse instance created. Run:",
                        "devshell-worker enroll",
                        `--controller ${code.controllerUrl}`,
                        `--device-code ${code.deviceCode}`,
                    ].join(" ") +
                    `\nCode expires: ${code.expiresAt}\nIf pairing fails, run: devshell instance device-code ${result.name}. Do not recreate the instance.`;
            } catch (error) {
                const failure = toRemoteError(error);
                this.options.store.setPanelError(
                    `instances:${result.name}:enrollment`,
                    failure,
                );
                status = [
                    `Reverse instance ${result.name} was created, but device code generation failed:`,
                    failure.message,
                    `Recover with: devshell instance device-code ${result.name}`,
                ].join(" ");
            }
        }
        await this.#refreshBestEffort(`instances:${result.name}`, async () => {
            await refreshTuiAll(this.options.domains);
        });
        return status;
    }

    async getInstanceCreateSchema(): Promise<InstanceCreateSchema> {
        return await this.#request(
            this.options.clients.instance.createInstanceSchema(),
            "instance.createSchema",
        );
    }

    async updateConfig(request: ConfigBatchUpdateRequest): Promise<JsonValue> {
        const result = await this.#request(
            this.options.clients.config.update(request),
            "config.update",
        );
        if (result?.cleanupPending === true)
            this.options.store.setScreenStatus(
                "config",
                "Config committed; Instance lifecycle cleanup remains pending.",
            );
        await this.#refreshBestEffort(this.#panelKey("config"), async () => {
            await this.options.domains.config.refresh();
        });
        return { restartControlRequired: result.restartControlRequired };
    }

    async updateInstanceConfig(
        instanceName: string,
        patch: ConfigInstancePatch,
    ): Promise<void> {
        const result = await this.#request(
            this.options.clients.instance.updateInstance({
                instanceName,
                patch,
            }),
            "config.instance.update:" + instanceName,
        );
        if (result?.cleanupPending === true)
            this.options.store.setScreenStatus(
                "instances",
                instanceName + " configuration committed; lifecycle cleanup remains pending.",
            );
    }

    async deleteInstance(instance: string): Promise<void> {
        const result = await this.#request(
            this.options.clients.instance.deleteInstance(instance),
            `instance.delete:${instance}`,
        );
        if (result?.cleanupPending === true) {
            this.options.store.setScreenStatus(
                "instances",
                `${instance} deregistered; lifecycle cleanup is pending.`,
            );
        } else if (
            Array.isArray(result?.cleanupWarnings) &&
            result.cleanupWarnings.length > 0
        ) {
            this.options.store.setScreenStatus(
                "instances",
                `${instance} deregistered; some remote provider resources could not be removed.`,
            );
        }
        await this.#refreshBestEffort(`instances:${instance}`, async () => {
            await refreshTuiAll(this.options.domains);
        });
    }

    async setInstanceEnabled(
        instance: string,
        enabled: boolean,
    ): Promise<void> {
        const result = await this.#request(
            this.options.clients.instance.updateInstance({
                instanceName: instance,
                patch: { enabled },
            }),
            "config.instance.enabled:" + instance,
        );
        if (result?.cleanupPending === true)
            this.options.store.setScreenStatus(
                "instances",
                instance + " configuration committed; lifecycle cleanup remains pending.",
            );
        await this.#refreshBestEffort("instances:" + instance, async () => {
            await refreshTuiAll(this.options.domains);
        });
    }

    async updateMcpEndpoint(mcp: ConfigMcpPatch): Promise<void> {
        await this.#request(
            this.options.clients.config.updateMcpEndpoint({ patch: mcp }),
            "config.mcp.endpoint.update",
        );
    }

    async updateWeb(web: ConfigWebPatch): Promise<void> {
        await this.#request(
            this.options.clients.config.updateWeb({ patch: web }),
            "config.web.update",
        );
    }

    async decideOAuthApproval(
        approvalId: string,
        decision: "approve" | "deny",
    ): Promise<void> {
        await this.options.domains.mcp.decideApproval(approvalId, decision);
        // The decision is committed at this point. Refetching the entire MCP
        // panel is best-effort and may stall on a slow domain connection; it
        // must not keep the keyboard confirmation overlay busy after approval.
        void this.#refreshBestEffort(
            this.#panelKey("connections"),
            async () => {
                await this.options.domains.mcp.refresh();
            },
        );
    }

    async validateConfigDraft(draft: ConfigDraft): Promise<void> {
        await this.#request(
            this.options.clients.config.validate(draft),
            "config.validate",
        );
    }

    async validateInstanceCreateDraft(
        draft: InstanceCreateDraft,
    ): Promise<InstanceCreateSummary> {
        return await this.#request(
            this.options.clients.instance.validateInstanceCreate(draft),
            `instance.validateCreate:${draft.name}`,
        );
    }

    async reloadPage(
        page: TuiPageId,
        instance: string | undefined,
    ): Promise<void> {
        switch (page) {
            case "overview":
                await this.options.domains.overview.refresh();
                return;
            case "instances":
            case "help":
                await refreshTuiAll(this.options.domains);
                return;
            case "terminal":
                return;
            case "goals":
                if (instance !== undefined)
                    await refreshTuiGoals(this.options.domains, instance);
                return;
            case "config":
                await this.options.domains.config.refresh();
                return;
            case "connections":
                await Promise.all([
                    this.options.domains.config.refresh(),
                    this.options.domains.mcp.refresh(),
                ]);
                return;
            case "messages":
                await refreshTuiMessages(this.options.domains);
                return;
            case "audit":
                if (instance !== undefined)
                    await refreshTuiAudit(this.options.domains, instance);
                return;
        }
    }

    async #refreshBestEffort(
        panelKey: string,
        refresh: () => Promise<void>,
    ): Promise<void> {
        const errorKey = `${panelKey}:operationRefresh`;
        try {
            await refresh();
            this.options.store.setPanelError(errorKey, undefined);
        } catch (error) {
            this.options.store.setPanelError(errorKey, toRemoteError(error));
        }
    }

    async #request<T>(request: Promise<T>, label: string): Promise<T> {
        return await withRequestTimeout(
            request,
            this.options.operationTimeoutMs,
            label,
            "uncertain",
        );
    }

    #panelKey(page: TuiPageId): string {
        return `${page}:${this.options.store.getState().ui.selectedInstance ?? "-"}`;
    }
}
