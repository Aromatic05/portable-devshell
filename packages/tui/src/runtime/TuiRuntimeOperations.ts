import {
    ControlError,
    createError,
    errorCodes,
    type InstanceCreateDraft,
    type InstanceCreateSchema,
    type InstanceCreateSummary,
    type JsonValue
} from "@portable-devshell/shared";

import { TuiAttachShellCommandResolver } from "./attach/TuiAttachShellCommandResolver.js";
import { TuiAttachShellRunner } from "./attach/TuiAttachShellRunner.js";
import type { TuiClients } from "./client/TuiClientComposition.js";
import type { TuiControlSession } from "./control/TuiControlSession.js";
import type { TuiAppStore } from "../state/TuiAppStore.js";
import type { TuiCommandRecord } from "../state/TuiStoreTypes.js";
import type { TuiPageId } from "../view/TuiUiModel.js";

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
    readonly #attachHooks?: TuiRuntimeOperationsOptions["attachHooks"];
    readonly #clients: TuiClients;
    readonly #reconnectDelayMs: number;
    readonly #session: TuiControlSession;
    readonly #store: TuiAppStore;
    #commandCounter = 0;

    constructor(options: TuiRuntimeOperationsOptions) {
        this.#attachHooks = options.attachHooks;
        this.#clients = options.clients;
        this.#reconnectDelayMs = options.reconnectDelayMs ?? 100;
        this.#session = options.session;
        this.#store = options.store;
    }

    async revokeArtifactShare(shareId: string): Promise<void> {
        await this.#clients.artifact.revokeShare(shareId);
        await this.#session.refreshArtifacts();
    }

    async cancelArtifactTransfer(transferId: string): Promise<void> {
        await this.#clients.artifact.cancelTransfer(transferId);
        await this.#session.refreshArtifacts();
    }

    async applyConfig(): Promise<JsonValue> {
        const result = await this.#clients.config.apply();
        await this.#session.refresh();
        return result;
    }

    async restartControl(): Promise<void> {
        await this.#clients.service.restart();
        if (this.#reconnectDelayMs > 0) {
            await new Promise((resolve) => {
                setTimeout(resolve, this.#reconnectDelayMs);
            });
        }
        await this.#session.reconnect();
    }

    async createInstance(draft: InstanceCreateDraft): Promise<string | undefined> {
        const result = await this.#clients.instance.create(draft);
        let status: string | undefined;
        if (draft.provider === "reverse") {
            const code = await this.#clients.reverse.createCode(result.name);
            status = [
                "Reverse instance created. Run:",
                "devshell-worker enroll",
                `--controller ${code.controllerUrl}`,
                `--device-code ${code.deviceCode}`,
                `(expires ${code.expiresAt})`
            ].join(" ");
        }
        await this.#session.refresh();
        return status;
    }

    async getInstanceCreateSchema(): Promise<InstanceCreateSchema> {
        return await this.#clients.instance.createSchema();
    }

    async updateInstanceConfig(
        instanceName: string,
        patch: Record<string, JsonValue>
    ): Promise<void> {
        await this.#clients.config.updateInstance({ instanceName, patch });
    }

    async deleteInstance(instance: string): Promise<void> {
        await this.#clients.instance.delete(instance);
        await this.#session.refresh();
    }

    async setInstanceEnabled(
        instance: string,
        enabled: boolean
    ): Promise<void> {
        const snapshot = this.#store.getState().snapshotsByInstance[instance];
        if (
            !enabled &&
            snapshot?.daemonState !== undefined &&
            snapshot.daemonState !== "stopped"
        ) {
            await this.#clients.runtime.stop(instance);
        }
        await this.#clients.config.updateInstance({
            instanceName: instance,
            patch: { enabled }
        });
        await this.#clients.config.apply();
        await this.#session.refresh();
    }

    async updateMcpConfig(mcp: Record<string, JsonValue>): Promise<void> {
        await this.#clients.config.updateMcp({ patch: mcp });
    }

    async decideOAuthApproval(
        approvalId: string,
        decision: "approve" | "deny"
    ): Promise<void> {
        await this.#clients.mcp.decideApproval(approvalId, decision);
        await this.#session.refresh();
    }

    async validateConfigDraft(
        draft: Record<string, JsonValue>
    ): Promise<void> {
        await this.#clients.config.validate(draft);
    }

    async validateInstanceCreateDraft(
        draft: InstanceCreateDraft
    ): Promise<InstanceCreateSummary> {
        return await this.#clients.instance.validateCreate(draft);
    }

    async reloadLogs(): Promise<void> {
        await this.#session.refreshLogs();
    }

    async reloadPage(
        page: TuiPageId,
        instance: string | undefined
    ): Promise<void> {
        switch (page) {
            case "instances":
            case "help":
                await this.#session.refresh();
                return;
            case "todo":
                if (instance !== undefined) {
                    await this.#session.refreshTodo(instance);
                }
                return;
            case "config":
            case "connector":
                await this.#session.refreshConfig();
                return;
            case "oauth":
                await this.#session.refreshOAuth();
                return;
            case "audit":
                if (instance !== undefined) {
                    await this.#session.refreshAudit(instance);
                }
                return;
            case "logs":
                if (instance !== undefined) {
                    await this.#session.refreshLogsForInstance(instance);
                }
                return;
        }
    }

    async runInstanceAction(
        action: "refresh" | "restart" | "start" | "stop",
        instance: string
    ): Promise<void> {
        switch (action) {
            case "refresh":
                await this.#runCommand(
                    `Refresh Status: ${instance}`,
                    instance,
                    async () => {
                        const result = await this.#clients.runtime.refresh(instance);
                        this.#store.replaceSnapshot(result.snapshot);
                        await this.#session.refreshInstance(instance);
                    }
                );
                return;
            case "start":
                await this.#startInstance(instance, "Start Worker");
                return;
            case "restart":
                await this.#runCommand(
                    `Restart Worker: ${instance}`,
                    instance,
                    async (commandId) => {
                        await this.#clients.runtime.stop(instance);
                        await this.#startInstanceWithinCommand(
                            instance,
                            commandId
                        );
                    }
                );
                return;
            case "stop":
                await this.#runCommand(
                    `Stop Worker: ${instance}`,
                    instance,
                    async () => {
                        const snapshot = await this.#clients.runtime.stop(instance);
                        this.#store.replaceSnapshot(snapshot);
                        await this.#session.refreshInstance(instance);
                    }
                );
        }
    }

    async attachShell(instance: string): Promise<void> {
        const entry = this.#store.getState().instances.find((candidate) => {
            return candidate.name === instance;
        });
        if (entry === undefined) {
            this.#store.setScreenStatus(
                this.#store.getState().ui.selectedPage,
                "Attach Shell failed: selected entry is unavailable."
            );
            return;
        }

        try {
            const command = new TuiAttachShellCommandResolver().resolve({
                configView: this.#store.getState().configView,
                environment: process.env,
                instance: entry,
                snapshot: this.#store.getState().snapshotsByInstance[instance]
            });
            await new TuiAttachShellRunner({
                hooks: {
                    resume: () => this.#attachHooks?.resume(),
                    suspend: () => this.#attachHooks?.suspend()
                }
            }).run(command);
        } catch (error) {
            this.#store.setScreenStatus(
                this.#store.getState().ui.selectedPage,
                `Attach Shell failed: ${readErrorMessage(error)}`
            );
            return;
        }

        try {
            const refreshed = await this.#clients.runtime.refresh(instance);
            this.#store.replaceSnapshot(refreshed.snapshot);
            await this.#session.refreshInstance(instance);
            this.#store.setScreenStatus(
                this.#store.getState().ui.selectedPage,
                "Shell exited. Status refreshed from control."
            );
        } catch (error) {
            this.#store.setScreenStatus(
                this.#store.getState().ui.selectedPage,
                `Shell exited. Status refresh failed: ${readErrorMessage(error)}`
            );
        }
    }

    async decideApproval(
        instance: string,
        approvalId: string,
        decision: "approve" | "deny"
    ): Promise<void> {
        await this.#runCommand(
            `${decision === "approve" ? "Approve" : "Deny"} Approval: ${approvalId}`,
            instance,
            async () => {
                await this.#clients.tool.getApproval(instance, approvalId);
                await this.#clients.tool.decideApproval(
                    instance,
                    approvalId,
                    decision
                );
                await this.#session.refreshInstance(instance);
            }
        );
    }

    async callTool(
        instance: string,
        toolName: string,
        input: string
    ): Promise<boolean> {
        return await this.#runCommand(
            `Call Tool: ${toolName}`,
            instance,
            async () => {
                const parsed = JSON.parse(input) as JsonValue;
                await this.#clients.tool.call(instance, toolName, parsed);
                await this.#session.refreshInstance(instance);
            }
        );
    }

    async #startInstance(
        instance: string,
        title: string
    ): Promise<void> {
        await this.#runCommand(
            `${title}: ${instance}`,
            instance,
            async (commandId) => {
                await this.#startInstanceWithinCommand(instance, commandId);
            }
        );
    }

    async #startInstanceWithinCommand(
        instance: string,
        commandId: string
    ): Promise<void> {
        const entry = this.#store.getState().instances.find((candidate) => {
            return candidate.name === instance;
        });
        this.#store.setRelayMetadata(commandId, {
            provider: entry?.provider,
            workspace: entry?.defaultWorkspace
        });
        const snapshot = await this.#clients.runtime.start(instance, {
            relay: {
                onOutput: (chunk) => {
                    this.#store.appendRelayOutput(commandId, chunk);
                },
                onRequestId: (requestId) => {
                    this.#store.setRelayMetadata(commandId, { requestId });
                }
            },
            workspacePath: entry?.defaultWorkspace
        });
        this.#store.replaceSnapshot(snapshot);
        await this.#session.refreshInstance(instance);
    }

    async #runCommand(
        title: string,
        targetInstance: string,
        operation: (commandId: string) => Promise<void>
    ): Promise<boolean> {
        const commandId = `tui-command-${++this.#commandCounter}`;
        const startedAt = new Date().toISOString();
        const sourcePanel = this.#store.getState().ui.selectedPage;
        const panelKey = `${sourcePanel}:${targetInstance}`;
        const command = {
            commandId,
            sourcePanel,
            startedAt,
            targetInstance,
            title
        };
        this.#store.upsertCommand({
            ...command,
            status: "running"
        });
        this.#store.setPanelError(panelKey, undefined);

        try {
            await operation(commandId);
            this.#completeCommand(command, "succeeded");
            this.#store.setScreenStatus(
                sourcePanel,
                `${title} completed.`
            );
            return true;
        } catch (error) {
            const failure = toControlError(error);
            this.#completeCommand(command, "failed", failure);
            this.#store.setPanelError(panelKey, failure);
            return false;
        }
    }

    #completeCommand(
        command: Omit<
            TuiCommandRecord,
            "completedAt" | "error" | "status"
        >,
        status: "succeeded" | "failed",
        error?: ControlError
    ): void {
        this.#store.upsertCommand({
            ...command,
            completedAt: new Date().toISOString(),
            ...(error === undefined ? {} : { error }),
            status
        });
    }
}

function toControlError(error: unknown): ControlError {
    if (error instanceof ControlError) {
        return error;
    }
    const candidate = error as {
        code?: unknown;
        message?: unknown;
        retryable?: unknown;
    } | undefined;
    return createError({
        code: typeof candidate?.code === "string"
            ? candidate.code
            : errorCodes.targetInvalid,
        message: typeof candidate?.message === "string"
            ? candidate.message
            : String(error),
        retryable: candidate?.retryable === true
    });
}

function readErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
