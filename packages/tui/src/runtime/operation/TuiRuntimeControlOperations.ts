import type {
    ConfigDraft,
    ConfigInstancePatch,
    ConfigMcpPatch,
    InstanceCreateDraft,
    InstanceCreateSchema,
    InstanceCreateSummary,
    JsonValue
} from "@portable-devshell/shared";

import type { TuiClients } from "../client/TuiClientComposition.js";
import type { TuiControlSession } from "../control/TuiControlSession.js";
import type { TuiPageId } from "../../state/TuiUiState.js";
import type { TuiAppStore } from "../../state/TuiAppStore.js";

export class TuiRuntimeControlOperations {
    constructor(private readonly options: {
        clients: TuiClients;
        reconnectDelayMs: number;
        session: TuiControlSession;
        store: TuiAppStore;
    }) {}

    async revokeArtifactShare(shareId: string): Promise<void> {
        await this.options.clients.artifact.revokeShare(shareId);
        await this.options.session.refreshArtifacts();
    }

    async cancelArtifactTransfer(transferId: string): Promise<void> {
        await this.options.clients.artifact.cancelTransfer(transferId);
        await this.options.session.refreshArtifacts();
    }

    async applyConfig(): Promise<JsonValue> {
        const result = await this.options.clients.config.apply();
        await this.options.session.refresh();
        return result;
    }

    async restartControl(): Promise<void> {
        await this.options.clients.service.restart();
        if (this.options.reconnectDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.options.reconnectDelayMs));
        }
        await this.options.session.reconnect();
    }

    async createInstance(draft: InstanceCreateDraft): Promise<string | undefined> {
        const result = await this.options.clients.instance.create(draft);
        let status: string | undefined;
        if (draft.provider === "reverse") {
            const code = await this.options.clients.reverse.createCode(result.name);
            status = [
                "Reverse instance created. Run:",
                "devshell-worker enroll",
                `--controller ${code.controllerUrl}`,
                `--device-code ${code.deviceCode}`,
                `(expires ${code.expiresAt})`
            ].join(" ");
        }
        await this.options.session.refresh();
        return status;
    }

    async getInstanceCreateSchema(): Promise<InstanceCreateSchema> {
        return await this.options.clients.instance.createSchema();
    }

    async updateInstanceConfig(instanceName: string, patch: ConfigInstancePatch): Promise<void> {
        await this.options.clients.config.updateInstance({ instanceName, patch });
    }

    async deleteInstance(instance: string): Promise<void> {
        await this.options.clients.instance.delete(instance);
        await this.options.session.refresh();
    }

    async setInstanceEnabled(instance: string, enabled: boolean): Promise<void> {
        const snapshot = this.options.store.getState().snapshotsByInstance[instance];
        if (!enabled && snapshot?.daemonState !== undefined && snapshot.daemonState !== "stopped") {
            await this.options.clients.runtime.stop(instance);
        }
        await this.options.clients.config.updateInstance({
            instanceName: instance,
            patch: { enabled }
        });
        await this.options.clients.config.apply();
        await this.options.session.refresh();
    }

    async updateMcpConfig(mcp: ConfigMcpPatch): Promise<void> {
        await this.options.clients.config.updateMcp({ patch: mcp });
    }

    async decideOAuthApproval(approvalId: string, decision: "approve" | "deny"): Promise<void> {
        await this.options.clients.mcp.decideApproval(approvalId, decision);
        await this.options.session.refresh();
    }

    async validateConfigDraft(draft: ConfigDraft): Promise<void> {
        await this.options.clients.config.validate(draft);
    }

    async validateInstanceCreateDraft(draft: InstanceCreateDraft): Promise<InstanceCreateSummary> {
        return await this.options.clients.instance.validateCreate(draft);
    }

    async reloadLogs(): Promise<void> {
        await this.options.session.refreshLogs();
    }

    async reloadPage(page: TuiPageId, instance: string | undefined): Promise<void> {
        switch (page) {
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
            case "connector":
                await this.options.session.refreshConfig();
                return;
            case "oauth":
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
}
