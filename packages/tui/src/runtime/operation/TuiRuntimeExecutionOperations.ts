import {
    ControlError,
    createError,
    toControlError,
    withRequestTimeout,
    type JsonValue
} from "@portable-devshell/shared";

import type { TuiClients } from "../client/TuiClientComposition.js";
import type { TuiControlSession } from "../control/TuiControlSession.js";
import type { TuiAppStore } from "../../state/TuiAppStore.js";
import type { TuiCommandRecord } from "../../state/reducer/TuiStoreModel.js";

export class TuiRuntimeExecutionOperations {
    #commandCounter = 0;

    constructor(private readonly options: {
        clients: TuiClients;
        operationTimeoutMs: number;
        session: TuiControlSession;
        store: TuiAppStore;
    }) {}

    async runInstanceAction(action: "refresh" | "restart" | "start" | "stop", instance: string): Promise<void> {
        switch (action) {
            case "refresh":
                await this.#runCommand(`Refresh Status: ${instance}`, instance, async () => {
                    await this.options.session.commands.refreshInstance(instance);
                    await this.#refreshInstanceBestEffort(instance);
                });
                return;
            case "start":
                await this.#startInstance(instance, "Start Worker");
                return;
            case "restart":
                await this.#runCommand(`Restart Worker: ${instance}`, instance, async (commandId) => {
                    await this.options.session.commands.stopInstance(instance);
                    await this.#startInstanceWithinCommand(instance, commandId);
                });
                return;
            case "stop":
                await this.#runCommand(`Stop Worker: ${instance}`, instance, async () => {
                    await this.options.session.commands.stopInstance(instance);
                    await this.#refreshInstanceBestEffort(instance);
                });
        }
    }

    async decideApproval(instance: string, approvalId: string, decision: "approve" | "deny"): Promise<void> {
        await this.#runCommand(
            `${decision === "approve" ? "Approve" : "Deny"} Approval: ${approvalId}`,
            instance,
            async () => {
                await this.options.session.commands.decideToolApproval(instance, approvalId, decision);
                await this.#refreshInstanceBestEffort(instance);
            }
        );
    }

    async callTool(instance: string, toolName: string, input: string): Promise<boolean> {
        return await this.#runCommand(`Call Tool: ${toolName}`, instance, async () => {
            const parsed = JSON.parse(input) as JsonValue;
            const feedback = await this.#request(
                this.options.clients.tool.call(instance, toolName, parsed),
                `tool.call:${toolName}`
            ) as {
                comment?: string[];
                error?: { code: string; message: string; retryable: boolean };
            };
            if (feedback?.error !== undefined) {
                throw createError(feedback.error);
            }
            if ((feedback?.comment?.length ?? 0) > 0) {
                this.options.store.setScreenStatus("todo", feedback.comment!.join(" "));
            }
            await this.#refreshInstanceBestEffort(instance);
        });
    }

    async #startInstance(instance: string, title: string): Promise<void> {
        await this.#runCommand(`${title}: ${instance}`, instance, async (commandId) => {
            await this.#startInstanceWithinCommand(instance, commandId);
        });
    }

    async #startInstanceWithinCommand(instance: string, commandId: string): Promise<void> {
        const entry = this.options.store.getState().instances.find((candidate) => candidate.name === instance);
        this.options.store.setRelayMetadata(commandId, {
            provider: entry?.provider,
            workspace: entry?.defaultWorkspace
        });
        await this.options.session.commands.startInstance(instance, {
            onOutput: (chunk) =>
                this.options.store.appendRelayOutput(commandId, chunk),
            onRequestId: (requestId) =>
                this.options.store.setRelayMetadata(commandId, { requestId }),
            workspacePath: entry?.defaultWorkspace,
        });
        await this.#refreshInstanceBestEffort(instance);
    }

    async #refreshInstanceBestEffort(instance: string): Promise<void> {
        const key = `${this.options.store.getState().ui.selectedPage}:${instance}:operationRefresh`;
        try {
            await this.options.session.refreshInstance(instance);
            this.options.store.setPanelError(key, undefined);
        } catch (error) {
            this.options.store.setPanelError(key, toControlError(error));
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

    async #runCommand(
        title: string,
        targetInstance: string,
        operation: (commandId: string) => Promise<void>
    ): Promise<boolean> {
        const commandId = `tui-command-${++this.#commandCounter}`;
        const startedAt = new Date().toISOString();
        const sourcePanel = this.options.store.getState().ui.selectedPage;
        const panelKey = `${sourcePanel}:${targetInstance}`;
        const command = { commandId, sourcePanel, startedAt, targetInstance, title };
        this.options.store.upsertCommand({ ...command, status: "running" });
        this.options.store.setPanelError(panelKey, undefined);
        try {
            await operation(commandId);
            this.#completeCommand(command, "succeeded");
            this.options.store.setScreenStatus(sourcePanel, `${title} completed.`);
            return true;
        } catch (error) {
            const failure = toControlError(error);
            this.#completeCommand(command, "failed", failure);
            this.options.store.setPanelError(panelKey, failure);
            return false;
        }
    }

    #completeCommand(
        command: Omit<TuiCommandRecord, "completedAt" | "error" | "status">,
        status: "succeeded" | "failed",
        error?: ControlError
    ): void {
        this.options.store.upsertCommand({
            ...command,
            completedAt: new Date().toISOString(),
            ...(error === undefined ? {} : { error }),
            status
        });
    }
}
