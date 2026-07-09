import type { ReadStream, WriteStream } from "node:tty";

import React from "react";
import { render, type Instance as InkInstance } from "ink";

import { TuiApp } from "./TuiApp.js";
import { TuiControlClient } from "../control/TuiControlClient.js";
import { TuiControlSession } from "../control/TuiControlSession.js";
import { CommandDispatcher } from "../interaction/CommandDispatcher.js";
import { KeyDispatcher } from "../interaction/KeyDispatcher.js";
import { TuiFocusManager } from "../interaction/TuiFocusManager.js";
import { RenderScheduler } from "../render/RenderScheduler.js";
import { buildFocusGraphForState } from "../screen/ScreenRouter.js";
import { TuiAppStore } from "../store/TuiAppStore.js";

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
        this.#ink = render(React.createElement(TuiApp, { runtime: this }), {
            exitOnCtrlC: false,
            stdin: this.#stdin,
            stdout: this.#stdout
        });

        await this.session.start();
        await this.#ink.waitUntilExit();
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
        this.#alternateScreen.exit();
    }

    redraw(): void {
        this.#stdout.write("\u001B[2J\u001B[H");
    }
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
