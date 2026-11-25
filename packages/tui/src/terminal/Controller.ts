import type { WriteStream } from "node:tty";

import type { TuiDomainSession } from "../app/control/Client.js";
import type { TuiAppStore } from "../state/store/App.js";
import type { TuiTerminalTab } from "../state/route/Model.js";
import { nextTuiTerminalTab } from "./Tabs.js";
import type { TuiTerminalInputAction } from "./Input.js";
import { selectTerminalTab } from "../view/projection/View.js";
import { buildTuiTerminalViewportRegion } from "../view/projection/HitRegion.js";
import {
    renderTerminalGraphicsFrame,
    terminalGraphicsClearSequence,
    type TuiTerminalGraphicsSupport,
} from "./graphics/Renderer.js";
import type { TuiTerminalSession } from "./emulation/Session.js";
import type { TuiSharedTerminalList } from "./SharedList.js";

export interface TuiTerminalMouseEvent {
    button: number;
    kind: "press" | "release";
    x: number;
    y: number;
}

export interface TuiTerminalControllerOptions {
    columns(): number;
    copyText(text: string): void;
    enqueueInput(operation: () => Promise<void> | void): void;
    graphicsSupport: TuiTerminalGraphicsSupport;
    handleAppMouse(event: TuiTerminalMouseEvent): Promise<void>;
    rows(): number;
    domains: TuiDomainSession;
    stdout: WriteStream;
    store: TuiAppStore;
    terminal: TuiTerminalSession;
    writeAppInput(data: string): void;
    sharedTerminals: TuiSharedTerminalList;
}

export class TuiTerminalController {
    readonly #options: TuiTerminalControllerOptions;
    #columns = 1;
    #focused = false;
    #instance?: string;
    #rows = 1;
    #selecting = false;
    #sharedInstance?: string;

    constructor(options: TuiTerminalControllerOptions) {
        this.#options = options;
    }

    invalidate(): void {
        this.#instance = undefined;
    }

    ownsInput(): boolean {
        const state = this.#options.store.getState();
        return (
            state.ui.selectedPage === "terminal" &&
            state.interaction.focusScope === "terminal"
        );
    }

    async open(
        instance: string | undefined,
        columns: number,
        rows: number,
    ): Promise<void> {
        this.#columns = Math.max(1, Math.floor(columns));
        this.#rows = Math.max(1, Math.floor(rows));

        if (instance === undefined) {
            this.#instance = undefined;
            this.#options.terminal.setUnavailable(
                "Select an instance from the lower sidebar list.",
                this.#columns,
                this.#rows,
            );
            return;
        }

        const current = this.#options.terminal.getSnapshot();
        if (
            this.#instance === instance &&
            (current.status === "starting" ||
                current.status === "running" ||
                current.status === "exited")
        ) {
            this.#options.terminal.resize(this.#columns, this.#rows);
            return;
        }

        const entry = this.#options.domains.instances.state.instances.find(
            (candidate) => candidate.name === instance,
        );
        if (entry === undefined) {
            this.#instance = instance;
            this.#options.terminal.setError(
                "Selected instance is unavailable.",
                this.#columns,
                this.#rows,
            );
            return;
        }

        try {
            this.#instance = instance;
            await this.#options.terminal.start({
                columns: this.#columns,
                command: { args: [], command: instance },
                instance,
                rows: this.#rows,
            });
        } catch (error) {
            this.#instance = instance;
            this.#options.terminal.setError(
                readErrorMessage(error),
                this.#columns,
                this.#rows,
            );
        }
    }

    selectTab(tab: TuiTerminalTab): void {
        const state = this.#options.store.getState();
        if (
            state.ui.selectedPage !== "terminal" ||
            selectTerminalTab(state) === tab
        )
            return;
        const keepTerminalFocus = state.interaction.focusScope === "terminal";
        if (tab === "instances") this.#leaveShared();
        this.#options.store.replaceRoute({
            page: "terminal",
            tab,
            view: "session",
        });
        if (keepTerminalFocus) this.#options.store.setFocusScope("terminal");
    }

    async syncSession(): Promise<void> {
        const state = this.#options.store.getState();
        const region = buildTuiTerminalViewportRegion(state, {
            columns: this.#options.columns(),
            rows: this.#options.rows(),
        });
        if (region === undefined) return;
        this.#columns = region.width;
        this.#rows = region.height;
        if (selectTerminalTab(state) === "sessions") {
            if (
                this.#options.sharedTerminals.getSnapshot().active !== undefined
            )
                this.#options.terminal.resize(region.width, region.height);
            return;
        }
        await this.open(state.ui.selectedInstance, region.width, region.height);
    }

    syncFocus(): void {
        const state = this.#options.store.getState();
        const focused =
            state.ui.selectedPage === "terminal" &&
            state.interaction.focusScope === "terminal" &&
            (selectTerminalTab(state) === "instances" ||
                this.#options.sharedTerminals.getSnapshot().active !==
                    undefined);
        if (focused === this.#focused) return;
        this.#focused = focused;
        this.#options.terminal.setFocused(focused);
        this.#options.stdout.write(
            focused ? "\u001B[?1h\u001B=" : "\u001B[?1l\u001B>",
        );
    }

    syncSharedTerminals(): void {
        const state = this.#options.store.getState();
        const instance =
            state.ui.selectedPage === "terminal" &&
            selectTerminalTab(state) === "sessions"
                ? state.ui.selectedInstance
                : undefined;
        if (instance === this.#sharedInstance) return;
        const wasShared = this.#sharedInstance !== undefined;
        this.#sharedInstance = instance;
        if (wasShared || instance !== undefined) this.#leaveShared();
        void this.#options.sharedTerminals.bind(instance);
    }

    #leaveShared(): void {
        this.#options.sharedTerminals.leave();
        this.#instance = undefined;
        this.#options.terminal.setUnavailable(
            "Select a terminal session.",
            this.#columns,
            this.#rows,
        );
    }

    async #attachShared(): Promise<void> {
        const session = this.#options.sharedTerminals.enter();
        if (session === undefined) return;
        await this.#options.terminal.start({
            columns: this.#columns,
            rows: this.#rows,
            command: { args: [session.terminalId], command: session.instance },
            instance: session.instance,
        });
        this.syncFocus();
    }

    scroll(direction: "pageUp" | "pageDown" | "top" | "bottom"): void {
        switch (direction) {
            case "pageUp":
                this.#options.terminal.scrollPages(-1);
                return;
            case "pageDown":
                this.#options.terminal.scrollPages(1);
                return;
            case "top":
                this.#options.terminal.scrollToTop();
                return;
            case "bottom":
                this.#options.terminal.scrollToBottom();
                return;
        }
    }

    scrollViewport(delta: number): void {
        if (
            selectTerminalTab(this.#options.store.getState()) === "sessions" &&
            this.#options.sharedTerminals.getSnapshot().active === undefined
        )
            this.#options.sharedTerminals.move(delta);
        else this.#options.terminal.scrollLines(delta);
    }

    renderGraphics(visible: boolean): void {
        if (
            !visible ||
            this.#options.store.getState().ui.selectedPage !== "terminal"
        ) {
            const clear = terminalGraphicsClearSequence(
                this.#options.graphicsSupport,
            );
            if (clear.length > 0) this.#options.stdout.write(clear);
            return;
        }
        const region = buildTuiTerminalViewportRegion(
            this.#options.store.getState(),
            {
                columns: this.#options.columns(),
                rows: this.#options.rows(),
            },
        );
        if (region === undefined) return;
        const snapshot = this.#options.terminal.getSnapshot();
        const transient = this.#options.terminal
            .takePendingGraphics()
            .filter((graphic) => !graphic.persistent)
            .map((graphic) => ({
                ...graphic,
                x: graphic.column,
                y: graphic.line - snapshot.scroll.viewportLine,
            }));
        const frame = renderTerminalGraphicsFrame({
            clear: true,
            graphics: [
                ...transient,
                ...this.#options.terminal.getVisibleGraphics(),
            ],
            region,
            support: this.#options.graphicsSupport,
        });
        if (frame.length > 0) this.#options.stdout.write(frame);
    }
    dispatchInputActions(actions: readonly TuiTerminalInputAction[]): void {
        let tab = selectTerminalTab(this.#options.store.getState());
        let focused = true;
        for (const action of actions) {
            if (action.type === "source.toggle") {
                tab = nextTuiTerminalTab(tab);
                this.selectTab(tab);
                continue;
            }
            if (action.type === "focus.leave") {
                focused = false;
                if (tab === "sessions") this.#leaveShared();
                const cursor =
                    this.#options.store.getState().interaction.sidebarCursor;
                this.#options.store.setFocusScope(
                    cursor?.kind === "instance"
                        ? "sidebarInstances"
                        : "sidebarContext",
                );
                continue;
            }
            if (!focused) {
                if (action.type === "data" || action.type === "paste") {
                    this.#options.writeAppInput(action.data);
                } else if (action.type === "mouse") {
                    this.#options.enqueueInput(
                        async () => await this.#options.handleAppMouse(action),
                    );
                }
                continue;
            }
            if (
                tab === "sessions" &&
                this.#options.sharedTerminals.getSnapshot().active === undefined
            ) {
                if (action.type === "data") {
                    const list = this.#options.sharedTerminals;
                    if (action.data === "\u001B[A" || action.data === "k")
                        list.move(-1);
                    else if (action.data === "\u001B[B" || action.data === "j")
                        list.move(1);
                    else if (action.data === "r") void list.refresh();
                    else if (action.data === "\r" || action.data === "\n")
                        this.#options.enqueueInput(() => this.#attachShared());
                } else if (action.type === "scroll")
                    listScroll(
                        this.#options.sharedTerminals,
                        action.direction,
                        this.#rows,
                    );
                else if (action.type === "mouse")
                    this.#options.enqueueInput(() =>
                        this.#options.handleAppMouse(action),
                    );
                continue;
            }
            if (action.type === "data")
                this.#options.terminal.writeInput(action.data);
            else if (action.type === "paste")
                this.#options.terminal.paste(action.data);
            else if (action.type === "scroll") this.scroll(action.direction);
            else if (action.type === "mouse")
                this.#options.enqueueInput(
                    async () => await this.handleMouse(action),
                );
        }
    }

    async handleMouse(event: TuiTerminalMouseEvent): Promise<void> {
        const region = buildTuiTerminalViewportRegion(
            this.#options.store.getState(),
            {
                columns: this.#options.columns(),
                rows: this.#options.rows(),
            },
        );
        if (region === undefined) {
            await this.#options.handleAppMouse(event);
            return;
        }
        const inside =
            event.x >= region.x &&
            event.x < region.x + region.width &&
            event.y >= region.y &&
            event.y < region.y + region.height;
        if (this.#selecting) {
            this.#options.terminal.updateSelection(
                Math.min(Math.max(1, event.x - region.x + 1), region.width),
                Math.min(Math.max(1, event.y - region.y + 1), region.height),
            );
            if (event.kind === "release") {
                this.#selecting = false;
                this.#options.copyText(
                    this.#options.terminal.getSelectionText(),
                );
            }
            return;
        }
        if (!inside) {
            await this.#options.handleAppMouse(event);
            return;
        }
        const relative = {
            button: event.button,
            kind: event.kind,
            x: event.x - region.x + 1,
            y: event.y - region.y + 1,
        } as const;
        const tracking =
            this.#options.terminal.getSnapshot().modes.mouseTracking;
        const selectionModifier = (event.button & 4) !== 0;
        const leftButton = (event.button & 3) === 0;
        const motion = (event.button & 32) !== 0;
        if (
            event.kind === "press" &&
            leftButton &&
            !motion &&
            (event.button & 64) === 0 &&
            (tracking === "none" || selectionModifier)
        ) {
            this.#selecting = true;
            this.#options.terminal.beginSelection(relative.x, relative.y);
            return;
        }
        if (this.#options.terminal.sendMouse(relative)) return;
        if (
            event.kind === "press" &&
            (event.button & 64) !== 0 &&
            tracking === "none"
        ) {
            this.#options.terminal.scrollLines(
                (event.button & 1) === 0 ? -3 : 3,
            );
        }
    }
}

function readErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function listScroll(
    list: TuiSharedTerminalList,
    direction: "pageUp" | "pageDown" | "top" | "bottom",
    rows: number,
): void {
    const length = list.getSnapshot().sessions.length;
    list.move(
        direction === "pageUp"
            ? -rows
            : direction === "pageDown"
              ? rows
              : direction === "top"
                ? -length
                : length,
    );
}
