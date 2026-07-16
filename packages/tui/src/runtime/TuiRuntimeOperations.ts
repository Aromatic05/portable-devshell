import type {
    ConfigDraft,
    ConfigInstancePatch,
    ConfigMcpPatch,
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

export interface TuiRuntimeOperationsOptions {
    attachHooks?: {
        resume(): void;
        suspend(): void;
    };
    clients: TuiClients;
    reconnectDelayMs?: number;
    session: TuiControlSession;
    store: TuiAppStore;
}

export class TuiRuntimeOperations {
    readonly #attach: TuiRuntimeAttachOperations;
    readonly #control: TuiRuntimeControlOperations;
    readonly #execution: TuiRuntimeExecutionOperations;

    constructor(options: TuiRuntimeOperationsOptions) {
        this.#attach = new TuiRuntimeAttachOperations(options);
        this.#control = new TuiRuntimeControlOperations({
            clients: options.clients,
            reconnectDelayMs: options.reconnectDelayMs ?? 100,
            session: options.session,
            store: options.store
        });
        this.#execution = new TuiRuntimeExecutionOperations(options);
    }

    async revokeArtifactShare(shareId: string): Promise<void> {
        await this.#control.revokeArtifactShare(shareId);
    }

    async cancelArtifactTransfer(transferId: string): Promise<void> {
        await this.#control.cancelArtifactTransfer(transferId);
    }

    async applyConfig(): Promise<JsonValue> {
        return await this.#control.applyConfig();
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

    async updateInstanceConfig(instanceName: string, patch: ConfigInstancePatch): Promise<void> {
        await this.#control.updateInstanceConfig(instanceName, patch);
    }

    async deleteInstance(instance: string): Promise<void> {
        await this.#control.deleteInstance(instance);
    }

    async setInstanceEnabled(instance: string, enabled: boolean): Promise<void> {
        await this.#control.setInstanceEnabled(instance, enabled);
    }

    async updateMcpConfig(mcp: ConfigMcpPatch): Promise<void> {
        await this.#control.updateMcpConfig(mcp);
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
}
