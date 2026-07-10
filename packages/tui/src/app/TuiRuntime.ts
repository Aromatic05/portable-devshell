import type { ReadStream, WriteStream } from "node:tty";
import { PassThrough } from "node:stream";

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
import { selectMainBoxFlowMetrics, selectMainScreenModel } from "../store/TuiSelectors.js";

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
    readonly #inkStdin: ReadStream;
    readonly #stdout: WriteStream;
    readonly #alternateScreen: AlternateScreen;
    #ink?: InkInstance;
    #commandCounter = 0;
    #attachResume?: () => void;
    #attachWait?: Promise<void>;
    #inputStarted = false;
    #mouseBuffer = "";
    #stopped = false;

    constructor(options: TuiRuntimeOptions = {}) {
        this.#stdin = options.stdin ?? process.stdin;
        this.#stdout = options.stdout ?? process.stdout;
        this.#inkStdin = createInkStdin(this.#stdin);
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
            onApplyConfig: async () => {
                await this.#client.applyConfig();
                await this.session.refresh();
            },
            onCreateInstance: async (draft) => {
                await this.#client.createInstance(draft);
                await this.session.refresh();
            },
            onGetInstanceCreateSchema: async () => await this.#client.getInstanceCreateSchema(),
            onInstanceConfigUpdate: async (instance) => {
                await this.#client.updateInstanceConfig(instance);
            },
            onInstanceDangerAction: async (action, instance) => {
                if (action === "delete") {
                    await this.#client.deleteInstance(instance);
                } else {
                    await this.#client.disableInstance(instance);
                }
                await this.session.refresh();
            },
            onMcpConfigUpdate: async (mcp) => {
                await this.#client.updateMcpConfig(mcp);
            },
            onValidateConfigDraft: async (draft) => {
                await this.#client.validateConfigDraft(draft);
            },
            onValidateInstanceCreateDraft: async (draft) => await this.#client.validateInstanceCreateDraft(draft),
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
        this.#startInput();
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
        this.#stopInput();
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
                environment: process.env,
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
            stdin: this.#inkStdin,
            stdout: this.#stdout
        });
    }

    #startInput(): void {
        if (this.#inputStarted) {
            return;
        }

        this.#inputStarted = true;
        this.#stdin.on("data", this.#forwardTerminalInput);
    }

    #stopInput(): void {
        if (!this.#inputStarted) {
            return;
        }

        this.#inputStarted = false;
        this.#stdin.off("data", this.#forwardTerminalInput);
    }

    #forwardTerminalInput = (chunk: string | Buffer): void => {
        if (this.#ink === undefined) {
            return;
        }

        const input = this.#mouseBuffer + chunk.toString();
        const pattern = /\u001B\[<(\d+);(\d+);(\d+)([Mm])/g;
        let cursor = 0;

        for (const match of input.matchAll(pattern)) {
            const start = match.index ?? 0;
            this.#inkStdin.write(input.slice(cursor, start));
            cursor = start + match[0].length;
            void this.#handleMouse({
                button: Number(match[1]),
                kind: match[4] === "M" ? "press" : "release",
                x: Number(match[2]),
                y: Number(match[3])
            });
        }

        const remainder = input.slice(cursor);
        const partialStart = remainder.lastIndexOf("\u001B[<");
        if (partialStart >= 0) {
            this.#inkStdin.write(remainder.slice(0, partialStart));
            this.#mouseBuffer = remainder.slice(partialStart);
            return;
        }

        this.#mouseBuffer = "";
        this.#inkStdin.write(remainder);
    };

    async #handleMouse(event: { button: number; kind: "press" | "release"; x: number; y: number }): Promise<void> {
        if (event.kind !== "press") {
            return;
        }

        const sidebarWidth = Math.floor(Math.max(0, this.columns - 3) * 0.15);
        if ((event.button & 64) !== 0) {
            if (event.x > sidebarWidth + 2) {
                await this.commandDispatcher.dispatch({ type: (event.button & 1) === 0 ? "screen.pageUp" : "screen.pageDown" });
            }
            return;
        }

        if ((event.button & 3) !== 0) {
            return;
        }

        if (event.x >= 2 && event.x <= sidebarWidth + 1) {
            await this.#handleSidebarClick(event.y);
            return;
        }

        if (event.x > sidebarWidth + 2) {
            await this.#handleMainClick(event.y);
        }
    }

    async #handleSidebarClick(row: number): Promise<void> {
        const pageIndex = row - 5;
        const pages = ["instances", "config", "connector", "audit", "logs", "help"] as const;
        const page = pages[pageIndex];
        if (page !== undefined) {
            await this.commandDispatcher.dispatch({ page, type: "page.select" });
            this.focusManager.setFocus({ id: page, kind: "page" });
            return;
        }

        const instance = this.store.getState().instances[row - 12];
        if (instance !== undefined) {
            this.store.setSelectedInstance(instance.name);
            this.focusManager.setFocus({ id: instance.name, kind: "instance" });
        }
    }

    async #handleMainClick(row: number): Promise<void> {
        const state = this.store.getState();
        const model = selectMainScreenModel(state);
        const metrics = selectMainBoxFlowMetrics(state);
        const scrollOffset = state.ui.scrollOffsets[metrics.scrollKey] ?? 0;
        const flowStartRow = 6 + (model.errorLines?.length ?? 0);
        const viewportRows = Math.max(0, this.rows - 8 - (model.statusLine === undefined ? 0 : 1) - (model.emptyState === undefined ? 0 : 1));
        const visibleFlowLines = Math.min(Math.max(0, metrics.totalLines - scrollOffset), viewportRows);
        const actionIndex = row - (flowStartRow + visibleFlowLines + (model.statusLine === undefined ? 0 : 1) + 2);
        const actionMenu = state.interaction.actionMenu;
        if (actionMenu.open && actionIndex >= 0 && actionIndex < actionMenu.items.length) {
            this.store.setActionMenu(actionMenu.title, actionMenu.items, actionIndex);
            await this.commandDispatcher.dispatch({ type: "actionMenu.submit" });
            return;
        }

        const flowLine = row - flowStartRow + scrollOffset;
        const box = model.boxes.find((candidate) => {
            const range = metrics.boxRanges[candidate.id];
            return range !== undefined && flowLine >= range.start && flowLine < range.end;
        });
        if (box === undefined) {
            return;
        }

        const range = metrics.boxRanges[box.id]!;
        if (flowLine === range.start) {
            this.focusManager.setFocus({ id: box.id, kind: "box" });
            await this.commandDispatcher.dispatch({ type: "screen.toggle" });
            return;
        }
        if (!box.expanded) {
            this.focusManager.setFocus({ id: box.id, kind: "box" });
            return;
        }

        const detailLine = box.expandedLines[flowLine - range.start - 1];
        if (detailLine?.id === undefined) {
            return;
        }

        if (state.interaction.editor?.kind === "create" && box.id === "create-wizard") {
            this.store.setSelectedDetailLine(box.expandedKey, detailLine.id);
            await this.commandDispatcher.dispatch({ type: "focus.activate" });
            return;
        }

        if (state.ui.selectedPage === "config" || state.ui.selectedPage === "connector") {
            this.focusManager.setFocus({ id: box.id, kind: "box" });
            await this.commandDispatcher.dispatch({ type: "focus.activate" });
            this.store.setSelectedDetailLine(box.expandedKey, detailLine.id);
            await this.commandDispatcher.dispatch({ type: "focus.activate" });
            return;
        }

        this.focusManager.setFocus({ id: box.id, kind: "box" });
        this.store.setFocusScope("boxDetail");
        this.store.setSelectedDetailLine(box.expandedKey, detailLine.id);
        await this.commandDispatcher.dispatch({ type: "focus.activate" });
    }

    #suspendForAttach(): void {
        if (this.#attachWait !== undefined) {
            return;
        }

        this.#attachWait = new Promise<void>((resolve) => {
            this.#attachResume = resolve;
        });
        this.#stopInput();
        this.#mouseBuffer = "";
        this.#ink?.unmount();
        this.#ink = undefined;
        this.#alternateScreen.exit();
    }

    #resumeAfterAttach(): void {
        this.#alternateScreen.enter();
        this.#mountInk();
        this.#startInput();
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

function createInkStdin(stdin: ReadStream): ReadStream {
    const proxy = new PassThrough() as PassThrough & {
        isTTY?: boolean;
        ref?(): PassThrough;
        setRawMode?(enabled: boolean): PassThrough;
        unref?(): PassThrough;
    };
    proxy.isTTY = stdin.isTTY;
    proxy.ref = () => {
        stdin.ref();
        return proxy;
    };
    proxy.setRawMode = (enabled) => {
        stdin.setRawMode?.(enabled);
        return proxy;
    };
    proxy.unref = () => {
        stdin.unref();
        return proxy;
    };
    return proxy as unknown as ReadStream;
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
        this.#stdout.write("\u001B[?1049h\u001B[?25l\u001B[?1000h\u001B[?1002h\u001B[?1006h");
    }

    exit(): void {
        if (!this.#active) {
            return;
        }

        this.#active = false;
        this.#stdout.write("\u001B[?1006l\u001B[?1002l\u001B[?1000l\u001B[?25h\u001B[?1049l");
    }
}
