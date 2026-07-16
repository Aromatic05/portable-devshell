import {
    ControlError,
    createError,
    errorCodes,
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
        session: TuiControlSession;
        store: TuiAppStore;
    }) {}

    async runInstanceAction(action: "refresh" | "restart" | "start" | "stop", instance: string): Promise<void> {
        switch (action) {
            case "refresh":
                await this.#runCommand(`Refresh Status: ${instance}`, instance, async () => {
                    const result = await this.options.clients.runtime.refresh(instance);
                    this.options.store.replaceSnapshot(result.snapshot);
                    await this.options.session.refreshInstance(instance);
                });
                return;
            case "start":
                await this.#startInstance(instance, "Start Worker");
                return;
            case "restart":
                await this.#runCommand(`Restart Worker: ${instance}`, instance, async (commandId) => {
                    await this.options.clients.runtime.stop(instance);
                    await this.#startInstanceWithinCommand(instance, commandId);
                });
                return;
            case "stop":
                await this.#runCommand(`Stop Worker: ${instance}`, instance, async () => {
                    const snapshot = await this.options.clients.runtime.stop(instance);
                    this.options.store.replaceSnapshot(snapshot);
                    await this.options.session.refreshInstance(instance);
                });
        }
    }

    async decideApproval(instance: string, approvalId: string, decision: "approve" | "deny"): Promise<void> {
        await this.#runCommand(
            `${decision === "approve" ? "Approve" : "Deny"} Approval: ${approvalId}`,
            instance,
            async () => {
                await this.options.clients.tool.getApproval(instance, approvalId);
                await this.options.clients.tool.decideApproval(instance, approvalId, decision);
                await this.options.session.refreshInstance(instance);
            }
        );
    }

    async callTool(instance: string, toolName: string, input: string): Promise<boolean> {
        return await this.#runCommand(`Call Tool: ${toolName}`, instance, async () => {
            const parsed = JSON.parse(input) as JsonValue;
            await this.options.clients.tool.call(instance, toolName, parsed);
            await this.options.session.refreshInstance(instance);
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
        const snapshot = await this.options.clients.runtime.start(instance, {
            relay: {
                onOutput: (chunk) => this.options.store.appendRelayOutput(commandId, chunk),
                onRequestId: (requestId) => this.options.store.setRelayMetadata(commandId, { requestId })
            },
            workspacePath: entry?.defaultWorkspace
        });
        this.options.store.replaceSnapshot(snapshot);
        await this.options.session.refreshInstance(instance);
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

function toControlError(error: unknown): ControlError {
    if (error instanceof ControlError) return error;
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown } | undefined;
    return createError({
        code: typeof candidate?.code === "string" ? candidate.code : errorCodes.targetInvalid,
        message: typeof candidate?.message === "string" ? candidate.message : String(error),
        retryable: candidate?.retryable === true
    });
}
