import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";

import React from "react";
import { render, type Instance as InkInstance } from "ink";

import {
    createTuiClients,
    type TuiClients
} from "./client/TuiClientComposition.js";
import { TuiCommandDispatcher } from "../interaction/command/dispatcher/TuiCommandDispatcher.js";
import { TuiControlSession } from "./control/TuiControlSession.js";
import { TuiFocusManager } from "../interaction/focus/TuiFocusManager.js";
import { TuiKeyDispatcher } from "../interaction/input/TuiKeyDispatcher.js";
import { TuiRenderScheduler } from "../view/render/TuiRenderScheduler.js";
import { buildFocusGraphForState } from "../view/screen/TuiScreenRouter.js";
import { TuiAppStore } from "../state/TuiAppStore.js";
import { selectMainScreenModel, tuiViewProjection } from "../view/model/TuiViewProjection.js";
import type { TuiPageId } from "../state/TuiUiState.js";
import { TuiApp } from "../view/TuiApp.js";
import type { TuiAppKey } from "../view/TuiAppController.js";
import {
    buildTuiHitRegions,
    buildTuiTextDetailImageRegion,
    buildTuiTerminalViewportRegion,
    hitTargetAt,
    type TuiHitTarget
} from "../view/TuiHitRegions.js";
import { TuiRuntimeOperations } from "./TuiRuntimeOperations.js";
import { TuiAttachShellCommandResolver } from "./attach/TuiAttachShellCommandResolver.js";
import {
    detectTerminalGraphicsSupport,
    renderTerminalGraphicsFrame,
    terminalGraphicsClearSequence,
    type TuiTerminalGraphicsMode,
    type TuiTerminalGraphicsSupport
} from "./terminal/TuiTerminalGraphicsRenderer.js";
import {
    detectTerminalImageSupport,
    renderTerminalImageFrame,
    terminalImageClearSequence,
    type TuiTerminalImageSupport
} from "./terminal/TuiTerminalImageRenderer.js";
import { TuiTerminalInputRouter } from "./terminal/TuiTerminalInputRouter.js";
import { TuiTerminalSession } from "./terminal/TuiTerminalSession.js";

export interface TuiRuntimeOptions {
    stdin?: ReadStream;
    stdout?: WriteStream;
    xdgRuntimeDir?: string;
}

export interface TuiRuntimeDependencies {
    clients?: TuiClients;
    graphicsMode?: TuiTerminalGraphicsMode;
    inkDebug?: boolean;
    terminal?: TuiTerminalSession;
}

export class TuiRuntime {
    readonly commandDispatcher: TuiCommandDispatcher;
    readonly focusManager: TuiFocusManager;
    readonly keyDispatcher: TuiKeyDispatcher;
    readonly scheduler: TuiRenderScheduler;
    readonly session: TuiControlSession;
    readonly store: TuiAppStore;
    readonly terminal: TuiTerminalSession;
    readonly #alternateScreen: AlternateScreen;
    readonly #inkDebug: boolean;
    readonly #inkStdin: ReadStream;
    readonly #operations: TuiRuntimeOperations;
    readonly #stdin: ReadStream;
    readonly #storeUnsubscribe: () => void;
    readonly #stdout: WriteStream;
    readonly #terminalGraphicsSupport: TuiTerminalGraphicsSupport;
    readonly #terminalImageSupport: TuiTerminalImageSupport;
    readonly #terminalInputRouter = new TuiTerminalInputRouter();
    #attachResume?: () => void;
    #attachWait?: Promise<void>;
    #cursorBlinkTimer?: ReturnType<typeof setInterval>;
    #ink?: InkInstance;
    #inputStarted = false;
    #mouseBuffer = "";
    #stopped = false;
    #terminalColumns = 1;
    #terminalFocused = false;
    #terminalInstance?: string;
    #terminalRows = 1;
    #terminalSelecting = false;

    constructor(
        options: TuiRuntimeOptions = {},
        dependencies: TuiRuntimeDependencies = {}
    ) {
        this.#stdin = options.stdin ?? process.stdin;
        this.#stdout = options.stdout ?? process.stdout;
        this.#inkDebug = dependencies.inkDebug ?? false;
        this.#terminalGraphicsSupport = detectTerminalGraphicsSupport(process.env, dependencies.graphicsMode);
        this.#terminalImageSupport = detectTerminalImageSupport(process.env, dependencies.graphicsMode);
        this.#inkStdin = createInkStdin(this.#stdin);
        this.#alternateScreen = new AlternateScreen(this.#stdout);
        this.store = new TuiAppStore();
        this.scheduler = new TuiRenderScheduler(this.store);
        this.terminal = dependencies.terminal ?? new TuiTerminalSession();
        this.#storeUnsubscribe = this.store.subscribe(() => this.#syncTerminalFocus());
        this.focusManager = new TuiFocusManager(this.store, {
            currentPage: () => this.store.getState().ui.selectedPage,
            graphFor: (page, mode) => buildFocusGraphForState({
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
        this.keyDispatcher = new TuiKeyDispatcher();

        const clients = dependencies.clients ?? createTuiClients({
            xdgRuntimeDir: options.xdgRuntimeDir
        });
        this.session = new TuiControlSession({
            clients,
            store: this.store
        });
        this.#operations = new TuiRuntimeOperations({
            attachHooks: {
                resume: () => this.#resumeAfterAttach(),
                suspend: () => this.#suspendForAttach()
            },
            clients,
            session: this.session,
            store: this.store
        });
        this.commandDispatcher = new TuiCommandDispatcher({
            focusManager: this.focusManager,
            mainViewportRows: () => Math.max(0, this.rows - 7),
            onApplyConfig: async () => await this.#operations.applyConfig(),
            onApprovalDecision: async (instance, approvalId, decision) => {
                await this.#operations.decideApproval(
                    instance,
                    approvalId,
                    decision
                );
            },
            onArtifactCancelTransfer: async (transferId) => {
                await this.#operations.cancelArtifactTransfer(transferId);
            },
            onArtifactRevokeShare: async (shareId) => {
                await this.#operations.revokeArtifactShare(shareId);
            },
            onArtifactViewImage: async (instance, input) =>
                await clients.artifact.viewImage(instance, input),
            onAttachShell: async (instance) => {
                await this.#operations.attachShell(instance);
            },
            onControlRestart: async () => {
                await this.#operations.restartControl();
            },
            onCreateInstance: async (draft) => {
                return await this.#operations.createInstance(draft);
            },
            onGetInstanceCreateSchema: async () => {
                return await this.#operations.getInstanceCreateSchema();
            },
            onInstanceAction: async (action, instance) => {
                await this.#operations.runInstanceAction(action, instance);
            },
            onInstanceConfigUpdate: async (instanceName, patch) => {
                await this.#operations.updateInstanceConfig(
                    instanceName,
                    patch
                );
            },
            onInstanceDangerAction: async (_action, instance) => {
                await this.#operations.deleteInstance(instance);
            },
            onInstanceEnabledChange: async (instance, enabled) => {
                await this.#operations.setInstanceEnabled(instance, enabled);
            },
            onLogsReload: async () => {
                await this.#operations.reloadLogs();
            },
            onMcpConfigUpdate: async (mcp) => {
                await this.#operations.updateMcpConfig(mcp);
            },
            onOAuthApprovalDecision: async (approvalId, decision) => {
                await this.#operations.decideOAuthApproval(
                    approvalId,
                    decision
                );
            },
            onPageReload: async (page, instance) => {
                if (page === "terminal") {
                    this.#terminalInstance = undefined;
                    await this.openTerminal(instance, this.#terminalColumns, this.#terminalRows);
                    return;
                }
                await this.#operations.reloadPage(page, instance);
            },
            onQuit: async () => {
                await this.stop();
            },
            onRedraw: () => {
                this.redraw();
            },
            onToolCall: async (instance, toolName, input) => {
                return await this.#operations.callTool(
                    instance,
                    toolName,
                    input
                );
            },
            onValidateConfigDraft: async (draft) => {
                await this.#operations.validateConfigDraft(draft);
            },
            projection: tuiViewProjection,
            onValidateInstanceCreateDraft: async (draft) => {
                return await this.#operations.validateInstanceCreateDraft(
                    draft
                );
            },
            store: this.store
        });
        this.focusManager.syncPanel(
            this.store.getState().ui.selectedPage,
            this.store.getState().interaction.focusScope
        );
    }

    async run(): Promise<void> {
        this.#alternateScreen.enter();
        this.#startInput();
        this.#startCursorBlink();
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

    async handleInput(input: string, key: TuiAppKey): Promise<void> {
        const intents = this.keyDispatcher.dispatch(
            this.store.getState().interaction.focusScope,
            { input, key }
        );
        await this.commandDispatcher.dispatchMany(intents);
    }

    async openTerminal(instance: string | undefined, columns: number, rows: number): Promise<void> {
        this.#terminalColumns = Math.max(1, Math.floor(columns));
        this.#terminalRows = Math.max(1, Math.floor(rows));

        if (instance === undefined) {
            this.#terminalInstance = undefined;
            this.terminal.setUnavailable(
                "Select an instance from the lower sidebar list.",
                this.#terminalColumns,
                this.#terminalRows
            );
            return;
        }

        const current = this.terminal.getSnapshot();
        if (
            this.#terminalInstance === instance
            && (current.status === "starting" || current.status === "running" || current.status === "exited")
        ) {
            this.terminal.resize(this.#terminalColumns, this.#terminalRows);
            return;
        }

        const entry = this.store.getState().instances.find((candidate) => candidate.name === instance);
        if (entry === undefined) {
            this.#terminalInstance = instance;
            this.terminal.setError(
                "Selected instance is unavailable.",
                this.#terminalColumns,
                this.#terminalRows
            );
            return;
        }

        try {
            const command = new TuiAttachShellCommandResolver().resolve({
                configView: this.store.getState().configView,
                environment: process.env,
                instance: entry,
                snapshot: this.store.getState().snapshotsByInstance[instance]
            });
            this.#terminalInstance = instance;
            await this.terminal.start({
                columns: this.#terminalColumns,
                command,
                environment: process.env,
                instance,
                rows: this.#terminalRows
            });
        } catch (error) {
            this.#terminalInstance = instance;
            this.terminal.setError(
                readErrorMessage(error),
                this.#terminalColumns,
                this.#terminalRows
            );
        }
    }

    async stop(): Promise<void> {
        if (this.#stopped) {
            return;
        }
        this.#stopped = true;
        this.#stopCursorBlink();
        this.renderTextDetailImage(false);
        this.renderTerminalGraphics(false);
        this.#storeUnsubscribe();
        this.terminal.dispose();
        await this.session.stop();
        this.scheduler.dispose();
        this.#ink?.unmount();
        this.#ink = undefined;
        this.#stopInput();
        this.#alternateScreen.exit();
    }

    redraw(): void {
        this.#stdout.write("\u001B[2J\u001B[H");
        queueMicrotask(() => {
            this.renderTextDetailImage(true);
            this.renderTerminalGraphics(true);
        });
    }

    renderTextDetailImage(visible: boolean): void {
        const detail = this.store.getState().interaction.textDetail;
        if (!visible || detail.open !== true || detail.image === undefined) {
            const clear = terminalImageClearSequence(this.#terminalImageSupport);
            if (clear.length > 0) {
                this.#stdout.write(clear);
            }
            return;
        }

        const region = buildTuiTextDetailImageRegion(this.store.getState(), {
            columns: this.columns,
            rows: this.rows
        });
        if (region === undefined) {
            return;
        }
        const frame = renderTerminalImageFrame({
            image: detail.image,
            region,
            support: this.#terminalImageSupport
        });
        if (frame.sequence.length > 0) {
            this.#stdout.write(frame.sequence);
        }
    }

    renderTerminalGraphics(visible: boolean): void {
        if (!visible || this.store.getState().ui.selectedPage !== "terminal") {
            const clear = terminalGraphicsClearSequence(this.#terminalGraphicsSupport);
            if (clear.length > 0) {
                this.#stdout.write(clear);
            }
            return;
        }

        const region = buildTuiTerminalViewportRegion(this.store.getState(), {
            columns: this.columns,
            rows: this.rows
        });
        if (region === undefined) {
            return;
        }

        const snapshot = this.terminal.getSnapshot();
        const transient = this.terminal.takePendingGraphics()
            .filter((graphic) => !graphic.persistent)
            .map((graphic) => ({
                ...graphic,
                x: graphic.column,
                y: graphic.line - snapshot.scroll.viewportLine
            }));
        const persistent = this.terminal.getVisibleGraphics();
        const graphics = [...transient, ...persistent];
        const frame = renderTerminalGraphicsFrame({
            clear: true,
            graphics,
            region,
            support: this.#terminalGraphicsSupport
        });
        if (frame.length > 0) {
            this.#stdout.write(frame);
        }
    }

    #startCursorBlink(): void {
        this.#cursorBlinkTimer = setInterval(() => {
            if (this.store.getState().interaction.editor?.editing === true) {
                this.store.bumpRedrawNonce();
            }
        }, 500);
    }

    #stopCursorBlink(): void {
        if (this.#cursorBlinkTimer === undefined) {
            return;
        }
        clearInterval(this.#cursorBlinkTimer);
        this.#cursorBlinkTimer = undefined;
    }

    #mountInk(): void {
        this.#ink = render(
            React.createElement(TuiApp, { runtime: this }),
            {
                debug: this.#inkDebug,
                exitOnCtrlC: false,
                stdin: this.#inkStdin,
                stdout: this.#stdout
            }
        );
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
        if (
            this.store.getState().ui.selectedPage === "terminal"
            && this.store.getState().interaction.focusScope === "terminal"
        ) {
            this.#mouseBuffer = "";
            let focused = true;
            for (const action of this.#terminalInputRouter.push(chunk.toString())) {
                if (action.type === "focus.leave") {
                    focused = false;
                    const cursor = this.store.getState().interaction.sidebarCursor;
                    this.store.setFocusScope(cursor?.kind === "instance" ? "sidebarInstances" : "sidebarPages");
                    continue;
                }
                if (action.type === "data") {
                    if (focused) {
                        this.terminal.writeInput(action.data);
                    } else {
                        this.#inkStdin.write(action.data);
                    }
                    continue;
                }
                if (action.type === "paste") {
                    if (focused) {
                        this.terminal.paste(action.data);
                    } else {
                        this.#inkStdin.write(action.data);
                    }
                    continue;
                }
                if (action.type === "scroll") {
                    if (focused) {
                        this.#scrollTerminal(action.direction);
                    }
                    continue;
                }
                if (focused) {
                    void this.#handleTerminalMouse(action);
                } else {
                    void this.#handleMouse(action);
                }
            }
            return;
        }
        this.#terminalInputRouter.reset();
        const input = this.#mouseBuffer + chunk.toString();
        const pattern = new RegExp(
            `${String.fromCharCode(27)}\\[<(\\d+);(\\d+);(\\d+)([Mm])`,
            "g"
        );
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

    #syncTerminalFocus(): void {
        const state = this.store.getState();
        const focused = state.ui.selectedPage === "terminal" && state.interaction.focusScope === "terminal";
        if (focused === this.#terminalFocused) {
            return;
        }
        this.#terminalFocused = focused;
        this.terminal.setFocused(focused);
        this.#stdout.write(focused ? "\u001B[?1h\u001B=" : "\u001B[?1l\u001B>");
        if (!focused) {
            this.#terminalSelecting = false;
            this.#terminalInputRouter.reset();
        }
    }

    #scrollTerminal(direction: "pageUp" | "pageDown" | "top" | "bottom"): void {
        switch (direction) {
            case "pageUp":
                this.terminal.scrollPages(-1);
                return;
            case "pageDown":
                this.terminal.scrollPages(1);
                return;
            case "top":
                this.terminal.scrollToTop();
                return;
            case "bottom":
                this.terminal.scrollToBottom();
                return;
        }
    }

    async #handleTerminalMouse(event: {
        button: number;
        kind: "press" | "release";
        x: number;
        y: number;
    }): Promise<void> {
        const region = buildTuiTerminalViewportRegion(this.store.getState(), {
            columns: this.columns,
            rows: this.rows
        });
        if (region === undefined) {
            await this.#handleMouse(event);
            return;
        }

        const inside = event.x >= region.x
            && event.x < region.x + region.width
            && event.y >= region.y
            && event.y < region.y + region.height;
        if (this.#terminalSelecting) {
            this.terminal.updateSelection(
                Math.min(Math.max(1, event.x - region.x + 1), region.width),
                Math.min(Math.max(1, event.y - region.y + 1), region.height)
            );
            if (event.kind === "release") {
                this.#terminalSelecting = false;
                this.#copyTerminalSelection();
            }
            return;
        }
        if (!inside) {
            await this.#handleMouse(event);
            return;
        }

        const relative = {
            button: event.button,
            kind: event.kind,
            x: event.x - region.x + 1,
            y: event.y - region.y + 1
        } as const;
        const tracking = this.terminal.getSnapshot().modes.mouseTracking;
        const selectionModifier = (event.button & 4) !== 0;
        const leftButton = (event.button & 3) === 0;
        const motion = (event.button & 32) !== 0;
        if (
            event.kind === "press"
            && leftButton
            && !motion
            && (event.button & 64) === 0
            && (tracking === "none" || selectionModifier)
        ) {
            this.#terminalSelecting = true;
            this.terminal.beginSelection(relative.x, relative.y);
            return;
        }
        if (this.terminal.sendMouse(relative)) {
            return;
        }

        if (
            event.kind === "press"
            && (event.button & 64) !== 0
            && tracking === "none"
        ) {
            this.terminal.scrollLines((event.button & 1) === 0 ? -3 : 3);
        }
    }

    #copyTerminalSelection(): void {
        const text = this.terminal.getSelectionText();
        if (text.length === 0) {
            return;
        }
        const encoded = Buffer.from(text, "utf8").toString("base64");
        this.#stdout.write(`\u001B]52;c;${encoded}\u0007`);
    }

    async #handleMouse(event: {
        button: number;
        kind: "press" | "release";
        x: number;
        y: number;
    }): Promise<void> {
        if (event.kind !== "press") {
            return;
        }
        const regions = buildTuiHitRegions(this.store.getState(), {
            columns: this.columns,
            rows: this.rows
        });
        if ((event.button & 64) !== 0) {
            const target = hitTargetAt(regions, event.x, event.y);
            if (target?.kind === "scrollViewport") {
                await this.commandDispatcher.dispatch({
                    type: (event.button & 1) === 0
                        ? "screen.pageUp"
                        : "screen.pageDown"
                });
            }
            return;
        }
        if ((event.button & 3) !== 0) {
            return;
        }
        const target = hitTargetAt(regions, event.x, event.y);
        if (target !== undefined) {
            await this.#handleHitTarget(target);
        }
    }

    async #handleHitTarget(target: TuiHitTarget): Promise<void> {
        if (target.kind === "page") {
            await this.commandDispatcher.dispatch({
                page: target.id as TuiPageId,
                type: "page.select"
            });
            this.focusManager.setFocus({
                id: target.id as TuiPageId,
                kind: "page"
            });
            return;
        }
        if (target.kind === "instance") {
            this.store.setSelectedInstance(target.id);
            this.focusManager.setFocus({ id: target.id, kind: "instance" });
            return;
        }
        if (target.kind === "scrollViewport") {
            return;
        }
        if (target.kind === "boxTitle") {
            this.focusManager.setFocus({ id: target.boxId, kind: "box" });
            await this.commandDispatcher.dispatch({ type: "screen.toggle" });
            return;
        }

        const state = this.store.getState();
        const box = selectMainScreenModel(state).boxes.find((candidate) => {
            return candidate.id === target.boxId;
        });
        if (box === undefined) {
            return;
        }
        if (!box.expanded) {
            this.focusManager.setFocus({ id: box.id, kind: "box" });
            return;
        }
        if (target.lineId === undefined) {
            return;
        }
        this.focusManager.setFocus({ id: box.id, kind: "box" });
        this.store.setSelectedDetailLine(box.expandedKey, target.lineId);
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
        this.#stdout.write(
            "\u001B[?1049h\u001B[?25l\u001B[?1000h\u001B[?1002h\u001B[?1006h\u001B[?2004h"
        );
    }

    exit(): void {
        if (!this.#active) {
            return;
        }
        this.#active = false;
        this.#stdout.write(
            "\u001B[?2004l\u001B[?1006l\u001B[?1002l\u001B[?1000l\u001B[?1l\u001B>\u001B[?25h\u001B[?1049l"
        );
    }
}
