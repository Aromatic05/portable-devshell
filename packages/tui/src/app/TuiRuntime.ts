import type { ReadStream, WriteStream } from "node:tty";

import React from "react";
import { render, type Instance as InkInstance } from "ink";
import { ControlError, createError, errorCodes, type JsonValue } from "@portable-devshell/shared";

import { TuiApp } from "./TuiApp.js";
import { AttachShellCommandResolver } from "../attach/AttachShellCommandResolver.js";
import { AttachShellRunner } from "../attach/AttachShellRunner.js";
import { TuiControlClient } from "../control/TuiControlClient.js";
import { TuiControlSession } from "../control/TuiControlSession.js";
import { CommandDispatcher } from "../interaction/CommandDispatcher.js";
import { KeyDispatcher } from "../interaction/KeyDispatcher.js";
import { TuiFocusManager } from "../interaction/TuiFocusManager.js";
import { RenderScheduler } from "../render/RenderScheduler.js";
import { buildFocusGraphForState } from "../screen/ScreenRouter.js";
import { TuiAppStore } from "../store/TuiAppStore.js";
import type { TuiCommandRecord } from "../store/TuiReducers.js";

export interface TuiRuntimeOptions {
    stdin?: ReadStream;
    stdout?: WriteStream;
    xdgRuntimeDir?: string;
}

export class TuiRuntime {
    readonly commandDispatcher: CommandDispatcher;
    readonly focusManager: TuiFocusManager;
    readonly keyDispatcher: KeyDispatcher;
    readonly scheduler: RenderScheduler;
    readonly session: TuiControlSession;
    readonly store: TuiAppStore;
    readonly #client: TuiControlClient;
    readonly #stdin: ReadStream;
    readonly #stdout: WriteStream;
    readonly #alternateScreen: AlternateScreen;
    #ink?: InkInstance;
    #commandCounter = 0;
    #attachResume?: () => void;
    #attachWait?: Promise<void>;
    #stopped = false;

    constructor(options: TuiRuntimeOptions = {}) {
        this.#stdin = options.stdin ?? process.stdin;
        this.#stdout = options.stdout ?? process.stdout;
        this.store = new TuiAppStore();
        this.scheduler = new RenderScheduler(this.store);
        this.focusManager = new TuiFocusManager(this.store, {
            currentPage: () => this.store.getState().ui.selectedPage,
            graphFor: (page, mode) =>
                buildFocusGraphForState({
                    ...this.store.getState(),
                    interaction: {
                        ...this.store.getState().interaction,
                        focusScope: mode
                    },
                    ui: {
                        ...this.store.getState().ui,
                        selectedPage: page
                    }
                }),
            mode: () => this.store.getState().interaction.focusScope
        });
        this.keyDispatcher = new KeyDispatcher();
        this.commandDispatcher = new CommandDispatcher({
            focusManager: this.focusManager,
            onApprovalDecision: async (instance, approvalId, decision) => {
                await this.#decideApproval(instance, approvalId, decision);
            },
            onInstanceAction: async (action, instance) => {
                await this.#runInstanceAction(action, instance);
            },
            onAttachShell: async (instance) => {
                await this.#attachShell(instance);
            },
            mainViewportRows: () => Math.max(0, this.rows - 7),
            onLogsReload: async () => {
                await this.session.refreshLogs();
            },
            onQuit: async () => {
                await this.stop();
            },
            onRedraw: () => {
                this.redraw();
            },
            onToolCall: async (instance, toolName, input) => await this.#callTool(instance, toolName, input),
            store: this.store
        });
        this.#client = new TuiControlClient({
            xdgRuntimeDir: options.xdgRuntimeDir
        });
        this.session = new TuiControlSession({
            client: this.#client,
            store: this.store
        });
        this.#alternateScreen = new AlternateScreen(this.#stdout);
        this.focusManager.syncPanel(this.store.getState().ui.selectedPage, this.store.getState().interaction.focusScope);
    }

    async run(): Promise<void> {
        this.#alternateScreen.enter();
        this.#mountInk();

        await this.session.start();
        while (!this.#stopped) {
            const ink = this.#ink;
            if (ink === undefined) {
                await this.#attachWait;
                continue;
            }

            await ink.waitUntilExit();
            if (this.#stopped) {
                break;
            }
            if (this.#attachWait !== undefined) {
                await this.#attachWait;
                continue;
            }
            break;
        }
        await this.stop();
    }

    async reconnect(): Promise<void> {
        await this.session.reconnect();
    }

    get columns(): number {
        return this.#stdout.columns ?? 120;
    }

    get rows(): number {
        return this.#stdout.rows ?? 40;
    }

    async handleInput(input: string, key: {
        backspace?: boolean;
        ctrl?: boolean;
        downArrow?: boolean;
        escape?: boolean;
        end?: boolean;
        home?: boolean;
        leftArrow?: boolean;
        pageDown?: boolean;
        pageUp?: boolean;
        return?: boolean;
        rightArrow?: boolean;
        shift?: boolean;
        tab?: boolean;
        upArrow?: boolean;
    }): Promise<void> {
        await this.commandDispatcher.dispatchMany(this.keyDispatcher.dispatch(this.store.getState().interaction.focusScope, { input, key }));
    }

    async stop(): Promise<void> {
        if (this.#stopped) {
            return;
        }

        this.#stopped = true;
        await this.session.stop();
        this.scheduler.dispose();
        this.#ink?.unmount();
        this.#ink = undefined;
        this.#alternateScreen.exit();
    }

    redraw(): void {
        this.#stdout.write("\u001B[2J\u001B[H");
    }

    async #runInstanceAction(action: "refresh" | "start" | "stop", instance: string): Promise<void> {
        switch (action) {
            case "refresh":
                await this.#runCommand(`Refresh Status: ${instance}`, instance, async () => {
                    const result = await this.#client.refreshStatus(instance);
                    this.store.replaceSnapshot(result.snapshot);
                    await this.session.refreshInstance(instance);
                });
                return;
            case "start":
                await this.#runCommand(`Start Worker: ${instance}`, instance, async (commandId) => {
                    const entry = this.store.getState().instances.find((candidate) => candidate.name === instance);
                    this.store.setRelayMetadata(commandId, {
                        provider: entry?.provider,
                        workspace: entry?.defaultWorkspace
                    });
                    const snapshot = await this.#client.startInstance(instance, {
                        relay: {
                            onOutput: (chunk) => {
                                this.store.appendRelayOutput(commandId, chunk);
                            },
                            onRequestId: (requestId) => {
                                this.store.setRelayMetadata(commandId, { requestId });
                            }
                        },
                        workspacePath: entry?.defaultWorkspace
                    });
                    this.store.replaceSnapshot(snapshot);
                    await this.session.refreshInstance(instance);
                });
                return;
            case "stop":
                await this.#runCommand(`Stop Worker: ${instance}`, instance, async () => {
                    const snapshot = await this.#client.stopInstance(instance);
                    this.store.replaceSnapshot(snapshot);
                    await this.session.refreshInstance(instance);
                });
        }
    }

    async #attachShell(instance: string): Promise<void> {
        const entry = this.store.getState().instances.find((candidate) => candidate.name === instance);
        if (entry === undefined) {
            this.store.setScreenStatus(this.store.getState().ui.selectedPage, "Attach Shell failed: selected entry is unavailable.");
            return;
        }

        try {
            const command = new AttachShellCommandResolver().resolve({
                configView: this.store.getState().configView,
                instance: entry,
                snapshot: this.store.getState().snapshotsByInstance[instance]
            });
            await new AttachShellRunner({
                hooks: {
                    resume: () => this.#resumeAfterAttach(),
                    suspend: () => this.#suspendForAttach()
                }
            }).run(command);
        } catch (error) {
            this.store.setScreenStatus(this.store.getState().ui.selectedPage, `Attach Shell failed: ${readErrorMessage(error)}`);
            return;
        }

        try {
            const refreshed = await this.#client.refreshStatus(instance);
            this.store.replaceSnapshot(refreshed.snapshot);
            await this.session.refreshInstance(instance);
            this.store.setScreenStatus(this.store.getState().ui.selectedPage, "Shell exited. Status refreshed from control.");
        } catch (error) {
            this.store.setScreenStatus(this.store.getState().ui.selectedPage, `Shell exited. Status refresh failed: ${readErrorMessage(error)}`);
        }
    }

    #mountInk(): void {
        this.#ink = render(React.createElement(TuiApp, { runtime: this }), {
            exitOnCtrlC: false,
            stdin: this.#stdin,
            stdout: this.#stdout
        });
    }

    #suspendForAttach(): void {
        if (this.#attachWait !== undefined) {
            return;
        }

        this.#attachWait = new Promise<void>((resolve) => {
            this.#attachResume = resolve;
        });
        this.#ink?.unmount();
        this.#ink = undefined;
        this.#alternateScreen.exit();
    }

    #resumeAfterAttach(): void {
        this.#alternateScreen.enter();
        this.#mountInk();
        const resume = this.#attachResume;
        this.#attachResume = undefined;
        this.#attachWait = undefined;
        resume?.();
    }

    async #decideApproval(instance: string, approvalId: string, decision: "approve" | "deny"): Promise<void> {
        await this.#runCommand(`${decision === "approve" ? "Approve" : "Deny"} Approval: ${approvalId}`, instance, async () => {
            await this.#client.getApproval(instance, approvalId);
            await this.#client.decideApproval(instance, approvalId, decision);
            await this.session.refreshInstance(instance);
        });
    }

    async #callTool(instance: string, toolName: string, input: string): Promise<boolean> {
        const result = await this.#runCommand(`Call Tool: ${toolName}`, instance, async () => {
            const parsed = JSON.parse(input) as JsonValue;
            await this.#client.callTool(instance, toolName, parsed);
            await this.session.refreshInstance(instance);
        });

        return result;
    }

    async #runCommand(title: string, targetInstance: string, operation: (commandId: string) => Promise<void>): Promise<boolean> {
        const commandId = `tui-command-${++this.#commandCounter}`;
        const startedAt = new Date().toISOString();
        const sourcePanel = this.store.getState().ui.selectedPage;
        const panelKey = `${sourcePanel}:${targetInstance}`;
        this.store.upsertCommand({
            commandId,
            sourcePanel,
            startedAt,
            status: "running",
            targetInstance,
            title
        });
        this.store.setPanelError(panelKey, undefined);

        try {
            await operation(commandId);
            this.#completeCommand({ commandId, sourcePanel, startedAt, targetInstance, title }, "succeeded");
            this.store.setScreenStatus(sourcePanel, `${title} completed.`);
            return true;
        } catch (error) {
            const failure = toControlError(error);
            this.#completeCommand({ commandId, sourcePanel, startedAt, targetInstance, title }, "failed", failure);
            this.store.setPanelError(panelKey, failure);
            return false;
        }
    }

    #completeCommand(
        command: Omit<TuiCommandRecord, "completedAt" | "error" | "status">,
        status: "succeeded" | "failed",
        error?: ControlError
    ): void {
        this.store.upsertCommand({
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

    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown } | undefined;
    return createError({
        code: typeof candidate?.code === "string" ? candidate.code : errorCodes.targetInvalid,
        message: typeof candidate?.message === "string" ? candidate.message : String(error),
        retryable: candidate?.retryable === true
    });
}

function readErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

class AlternateScreen {
    readonly #stdout: WriteStream;
    #active = false;

    constructor(stdout: WriteStream) {
        this.#stdout = stdout;
    }

    enter(): void {
        if (this.#active) {
            return;
        }

        this.#active = true;
        this.#stdout.write("\u001B[?1049h\u001B[?25l");
    }

    exit(): void {
        if (!this.#active) {
            return;
        }

        this.#active = false;
        this.#stdout.write("\u001B[?25h\u001B[?1049l");
    }
}
