import type { TuiMode, TuiUiIntent } from "./TuiInteractionTypes.js";
import { pageFromShortcut } from "../screen/ScreenRouter.js";

export interface TuiKeyPress {
    input: string;
    key: {
        backspace?: boolean;
        ctrl?: boolean;
        delete?: boolean;
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
    };
}

export class KeyDispatcher {
    dispatch(mode: TuiMode, press: TuiKeyPress): TuiUiIntent[] {
        const globalIntent = this.#global(mode, press);
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
            case "toolForm":
                return this.#forToolForm(press);
            case "form":
            case "wizard":
                return this.#forEditor(press, mode);
            case "sidebarPages":
            case "sidebarInstances":
            case "mainBoxes":
            case "boxDetail":
                return this.#forMainScopes(mode, press);
        }
    }

    #global(mode: TuiMode, press: TuiKeyPress): TuiUiIntent | undefined {
        if (press.key.ctrl && press.input === "d") {
            return mode === "form" || mode === "wizard" ? undefined : { type: "app.requestQuit" };
        }
        if (press.key.escape || press.input === "\u001B") {
            return { type: "ui.cancel" };
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
        if (press.input.length === 1 && !press.key.ctrl) {
            return [{ text: press.input, type: "search.append" }];
        }
        return [];
    }

    #forToolForm(press: TuiKeyPress): TuiUiIntent[] {
        if (press.key.backspace) {
            return [{ type: "toolForm.backspace" }];
        }
        if (press.key.return) {
            return [{ type: "toolForm.submit" }];
        }
        if (press.input.length === 1 && !press.key.ctrl) {
            return [{ text: press.input, type: "toolForm.append" }];
        }
        return [];
    }

    #forEditor(press: TuiKeyPress, mode: "form" | "wizard"): TuiUiIntent[] {
        if (press.key.ctrl && (press.input === "s" || press.input === "S")) {
            return [{ type: "editor.save" }];
        }
        if (press.key.ctrl && press.input === "d") {
            return [{ type: "editor.discard" }];
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
        if (press.key.return) {
            return [{ type: "focus.activate" }];
        }
        if (press.key.leftArrow) {
            return [{ direction: "left", type: "editor.cursorMove" }];
        }
        if (press.key.rightArrow) {
            return [{ direction: "right", type: "editor.cursorMove" }];
        }
        if (press.key.backspace || press.key.delete) {
            return [{ type: "editor.backspace" }];
        }
        if (press.input.length === 1 && !press.key.ctrl) {
            return [{ text: press.input, type: "editor.append" }];
        }
        return [];
    }

    #forMainScopes(mode: "sidebarPages" | "sidebarInstances" | "mainBoxes" | "boxDetail", press: TuiKeyPress): TuiUiIntent[] {
        if (isShortcutDigit(press.input)) {
            const page = pageFromShortcut(Number(press.input));
            return page === undefined ? [] : [{ page, type: "page.select" }];
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
        if (press.input === "/") {
            return [{ type: "search.open" }];
        }
        if (press.input === "a") {
            return [{ type: "actionMenu.open" }];
        }
        if (press.input === "?") {
            return [{ type: "ui.help" }];
        }
        if (press.input === "r" || press.input === "R") {
            return [{ type: "logs.reload" }];
        }
        return [];
    }
}

function isShortcutDigit(input: string): input is "1" | "2" | "3" | "4" | "5" | "6" {
    return input === "1" || input === "2" || input === "3" || input === "4" || input === "5" || input === "6";
}
