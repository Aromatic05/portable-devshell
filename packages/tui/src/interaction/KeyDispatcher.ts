import type { TuiMode, TuiUiIntent } from "./TuiInteractionTypes.js";

export interface TuiKeyPress {
    input: string;
    key: {
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
    };
}

export class KeyDispatcher {
    dispatch(mode: TuiMode, press: TuiKeyPress): TuiUiIntent[] {
        const globalIntent = this.#global(press);

        if (globalIntent !== undefined) {
            return [globalIntent];
        }

        switch (mode) {
            case "actionMenu":
                return this.#forActionMenu(press);
            case "confirm":
                return this.#forConfirm(press);
            case "search":
                return this.#forSearch(press);
            case "edit":
            case "normal":
                return this.#forPanel(mode, press);
        }
    }

    #global(press: TuiKeyPress): TuiUiIntent | undefined {
        if (press.key.ctrl && press.input === "d") {
            return { type: "app.requestQuit" };
        }

        if (press.key.ctrl && press.input === "[") {
            return { type: "ui.cancel" };
        }

        if (press.key.ctrl && (press.input === "l" || press.input === "L")) {
            return { type: "ui.redraw" };
        }

        return undefined;
    }

    #forActionMenu(press: TuiKeyPress): TuiUiIntent[] {
        if (press.key.upArrow) {
            return [{ direction: "up", type: "actionMenu.move" }];
        }

        if (press.key.downArrow) {
            return [{ direction: "down", type: "actionMenu.move" }];
        }

        if (press.key.return) {
            return [{ type: "actionMenu.submit" }];
        }

        return [];
    }

    #forConfirm(press: TuiKeyPress): TuiUiIntent[] {
        if (press.key.tab && press.key.shift) {
            return [{ direction: "previous", type: "focus.move" }];
        }

        if (press.key.tab || press.key.leftArrow) {
            return [{ direction: "previous", type: "focus.move" }];
        }

        if (press.key.rightArrow) {
            return [{ direction: "next", type: "focus.move" }];
        }

        if (press.key.return) {
            return [{ type: "confirm.accept" }];
        }

        return [];
    }

    #forSearch(press: TuiKeyPress): TuiUiIntent[] {
        if (press.key.backspace) {
            return [{ type: "search.backspace" }];
        }

        if (press.key.return) {
            return [{ type: "search.submit" }];
        }

        if (isPrintableInput(press)) {
            return [{ text: press.input, type: "search.append" }];
        }

        return [];
    }

    #forPanel(mode: "edit" | "normal", press: TuiKeyPress): TuiUiIntent[] {
        if (isPanelShortcut(press.input)) {
            return [{ panel: panelFromDigit(press.input), type: "panel.activate" }];
        }

        if (press.input === "[") {
            return [{ direction: "previous", type: "panel.cycle" }];
        }

        if (press.input === "]") {
            return [{ direction: "next", type: "panel.cycle" }];
        }

        if (press.key.tab && press.key.shift) {
            return [{ direction: "previous", type: "focus.move" }];
        }

        if (press.key.tab) {
            return [{ direction: "next", type: "focus.move" }];
        }

        if (press.key.upArrow) {
            return [{ direction: "up", type: "focus.move" }];
        }

        if (press.key.downArrow) {
            return [{ direction: "down", type: "focus.move" }];
        }

        if (press.key.leftArrow) {
            return [{ direction: "left", type: "focus.move" }];
        }

        if (press.key.rightArrow) {
            return [{ direction: "right", type: "focus.move" }];
        }

        if (press.key.pageUp) {
            return [{ type: "screen.pageUp" }];
        }

        if (press.key.pageDown) {
            return [{ type: "screen.pageDown" }];
        }

        if (press.key.home) {
            return [{ type: "screen.home" }];
        }

        if (press.key.end) {
            return [{ type: "screen.end" }];
        }

        if (press.key.return) {
            return [{ type: "focus.activate" }];
        }

        if (press.input === " ") {
            return [{ type: "screen.toggle" }];
        }

        if (press.input === "a") {
            return [{ type: "actionMenu.open" }];
        }

        if (press.input === "/") {
            return [{ type: "search.open" }];
        }

        if (press.input === "?") {
            return [{ type: "ui.help" }];
        }

        if (mode === "normal" && (press.input === "r" || press.input === "R")) {
            return [{ type: "logs.reload" }];
        }

        if (mode === "normal" && (press.input === "f" || press.input === "F")) {
            return [{ type: "logs.toggleFollow" }];
        }

        if (mode === "normal" && (press.input === "c" || press.input === "C")) {
            return [{ type: "logs.clearBuffer" }];
        }

        return [];
    }
}

function isPrintableInput(press: TuiKeyPress): boolean {
    return press.input.length === 1 && !press.key.ctrl;
}

function isPanelShortcut(input: string): input is "1" | "2" | "3" | "4" | "5" | "6" {
    return input === "1" || input === "2" || input === "3" || input === "4" || input === "5" || input === "6";
}

function panelFromDigit(input: "1" | "2" | "3" | "4" | "5" | "6") {
    switch (input) {
        case "1":
            return "instances";
        case "2":
            return "connector";
        case "3":
            return "audit";
        case "4":
            return "logs";
        case "5":
            return "approvals";
        case "6":
            return "help";
    }
}
