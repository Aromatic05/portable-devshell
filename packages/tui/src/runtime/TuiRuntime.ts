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
    hitTargetAt,
    type TuiHitTarget
} from "../view/TuiHitRegions.js";
import { TuiRuntimeOperations } from "./TuiRuntimeOperations.js";

export interface TuiRuntimeOptions {
    stdin?: ReadStream;
    stdout?: WriteStream;
    xdgRuntimeDir?: string;
}

export interface TuiRuntimeDependencies {
    clients?: TuiClients;
}

export class TuiRuntime {
    readonly commandDispatcher: TuiCommandDispatcher;
    readonly focusManager: TuiFocusManager;
    readonly keyDispatcher: TuiKeyDispatcher;
    readonly scheduler: TuiRenderScheduler;
    readonly session: TuiControlSession;
    readonly store: TuiAppStore;
    readonly #alternateScreen: AlternateScreen;
    readonly #inkStdin: ReadStream;
    readonly #operations: TuiRuntimeOperations;
    readonly #stdin: ReadStream;
    readonly #stdout: WriteStream;
    #attachResume?: () => void;
    #attachWait?: Promise<void>;
    #cursorBlinkTimer?: ReturnType<typeof setInterval>;
    #ink?: InkInstance;
    #inputStarted = false;
    #mouseBuffer = "";
    #stopped = false;

    constructor(
        options: TuiRuntimeOptions = {},
        dependencies: TuiRuntimeDependencies = {}
    ) {
        this.#stdin = options.stdin ?? process.stdin;
        this.#stdout = options.stdout ?? process.stdout;
        this.#inkStdin = createInkStdin(this.#stdin);
        this.#alternateScreen = new AlternateScreen(this.#stdout);
        this.store = new TuiAppStore();
        this.scheduler = new TuiRenderScheduler(this.store);
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

    async stop(): Promise<void> {
        if (this.#stopped) {
            return;
        }
        this.#stopped = true;
        this.#stopCursorBlink();
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
            "\u001B[?1049h\u001B[?25l\u001B[?1000h\u001B[?1002h\u001B[?1006h"
        );
    }

    exit(): void {
        if (!this.#active) {
            return;
        }
        this.#active = false;
        this.#stdout.write(
            "\u001B[?1006l\u001B[?1002l\u001B[?1000l\u001B[?25h\u001B[?1049l"
        );
    }
}
