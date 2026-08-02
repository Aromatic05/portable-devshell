import type {
    ConfigBatchUpdateRequest,
    ConfigDraft,
    ConfigInstancePatch,
    ConfigMcpPatch,
    ConfigWebPatch,
    InstanceCreateDraft,
    InstanceCreateSchema,
    InstanceCreateSummary,
    JsonValue
} from "@portable-devshell/shared";

import type { TuiClients } from "./client/TuiClientComposition.js";
import type { TuiControlSession } from "./control/TuiControlSession.js";
import type { TuiAppStore } from "../state/TuiAppStore.js";
import type { TuiPageId } from "../state/TuiUiState.js";
import { TuiRuntimeAttachOperations } from "./operation/TuiRuntimeAttachOperations.js";
import { TuiRuntimeControlOperations } from "./operation/TuiRuntimeControlOperations.js";
import { TuiRuntimeExecutionOperations } from "./operation/TuiRuntimeExecutionOperations.js";
import { TuiRuntimeTmuxOperations } from "./operation/TuiRuntimeTmuxOperations.js";

export interface TuiRuntimeOperationsOptions {
    attachHooks?: {
        resume(): void;
        suspend(): void;
    };
    clients: TuiClients;
    operationTimeoutMs?: number;
    reconnectDelayMs?: number;
    session: TuiControlSession;
    store: TuiAppStore;
}

export class TuiRuntimeOperations {
    readonly #attach: TuiRuntimeAttachOperations;
    readonly #control: TuiRuntimeControlOperations;
    readonly #execution: TuiRuntimeExecutionOperations;
    readonly #tmux: TuiRuntimeTmuxOperations;

    constructor(options: TuiRuntimeOperationsOptions) {
        this.#attach = new TuiRuntimeAttachOperations(options);
        this.#control = new TuiRuntimeControlOperations({
            clients: options.clients,
            operationTimeoutMs: options.operationTimeoutMs ?? 30_000,
            reconnectDelayMs: options.reconnectDelayMs ?? 100,
            session: options.session,
            store: options.store
        });
        this.#execution = new TuiRuntimeExecutionOperations({
            ...options,
            operationTimeoutMs: options.operationTimeoutMs ?? 30_000
        });
        this.#tmux = new TuiRuntimeTmuxOperations({
            clients: options.clients,
            operationTimeoutMs: options.operationTimeoutMs ?? 30_000
        });
    }

    async revokeArtifactShare(shareId: string): Promise<void> {
        await this.#control.revokeArtifactShare(shareId);
    }

    async cancelArtifactTransfer(transferId: string): Promise<void> {
        await this.#control.cancelArtifactTransfer(transferId);
    }

    async queueContextMessage(instance: string, ctxId: string, text: string): Promise<void> {
        await this.#control.queueContextMessage(instance, ctxId, text);
    }

    async restartControl(): Promise<void> {
        await this.#control.restartControl();
    }

    async createInstance(draft: InstanceCreateDraft): Promise<string | undefined> {
        return await this.#control.createInstance(draft);
    }

    async getInstanceCreateSchema(): Promise<InstanceCreateSchema> {
        return await this.#control.getInstanceCreateSchema();
    }

    async updateConfig(request: ConfigBatchUpdateRequest): Promise<JsonValue> {
        return await this.#control.updateConfig(request);
    }

    async updateInstanceConfig(instanceName: string, patch: ConfigInstancePatch): Promise<void> {
        await this.#control.updateInstanceConfig(instanceName, patch);
    }

    async deleteInstance(instance: string): Promise<void> {
        await this.#control.deleteInstance(instance);
    }

    async setInstanceEnabled(instance: string, enabled: boolean): Promise<void> {
        await this.#control.setInstanceEnabled(instance, enabled);
    }

    async updateMcpEndpoint(mcp: ConfigMcpPatch): Promise<void> {
        await this.#control.updateMcpEndpoint(mcp);
    }

    async updateWeb(web: ConfigWebPatch): Promise<void> {
        await this.#control.updateWeb(web);
    }

    async decideOAuthApproval(approvalId: string, decision: "approve" | "deny"): Promise<void> {
        await this.#control.decideOAuthApproval(approvalId, decision);
    }

    async validateConfigDraft(draft: ConfigDraft): Promise<void> {
        await this.#control.validateConfigDraft(draft);
    }

    async validateInstanceCreateDraft(draft: InstanceCreateDraft): Promise<InstanceCreateSummary> {
        return await this.#control.validateInstanceCreateDraft(draft);
    }

    async reloadLogs(): Promise<void> {
        await this.#control.reloadLogs();
    }

    async reloadPage(page: TuiPageId, instance: string | undefined): Promise<void> {
        await this.#control.reloadPage(page, instance);
    }

    async runInstanceAction(
        action: "refresh" | "restart" | "start" | "stop",
        instance: string
    ): Promise<void> {
        await this.#execution.runInstanceAction(action, instance);
    }

    async attachShell(instance: string): Promise<void> {
        await this.#attach.attachShell(instance);
    }

    async decideApproval(
        instance: string,
        approvalId: string,
        decision: "approve" | "deny"
    ): Promise<void> {
        await this.#execution.decideApproval(instance, approvalId, decision);
    }

    async callTool(instance: string, toolName: string, input: string): Promise<boolean> {
        return await this.#execution.callTool(instance, toolName, input);
    }

    get tmuxOperations(): TuiRuntimeTmuxOperations {
        return this.#tmux;
    }

}
