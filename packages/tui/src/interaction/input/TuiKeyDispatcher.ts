import type { TuiMode, TuiUiIntent } from "../../state/TuiInteractionState.js";
import { pageFromShortcut } from "../../state/TuiPageNavigation.js";

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

export class TuiKeyDispatcher {
    dispatch(mode: TuiMode, press: TuiKeyPress): TuiUiIntent[] {
        if (mode === "terminal") {
            return [];
        }
        const globalIntent = this.#global(mode, press);
        if (globalIntent !== undefined) {
            return [globalIntent];
        }

        switch (mode) {
            case "confirm":
                return this.#forConfirm(press);
            case "textDetail":
                return this.#forTextDetail(press);
            case "approvalDetail":
            case "denyConfirm":
                return this.#forApprovalDetail(press);
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
                return this.#forMainScopes(press);
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


    #forTextDetail(press: TuiKeyPress): TuiUiIntent[] {
        if (press.key.upArrow) {
            return [{ delta: -1, type: "textDetail.scroll" }];
        }
        if (press.key.downArrow) {
            return [{ delta: 1, type: "textDetail.scroll" }];
        }
        if (press.key.pageUp) {
            return [{ delta: -10, type: "textDetail.scroll" }];
        }
        if (press.key.pageDown) {
            return [{ delta: 10, type: "textDetail.scroll" }];
        }
        if (press.key.home) {
            return [{ delta: -1_000_000, type: "textDetail.scroll" }];
        }
        if (press.key.end) {
            return [{ delta: 1_000_000, type: "textDetail.scroll" }];
        }
        if (press.key.return) {
            return [{ type: "textDetail.close" }];
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

    #forApprovalDetail(press: TuiKeyPress): TuiUiIntent[] {
        if (press.key.tab && press.key.shift) {
            return [{ direction: "previous", type: "focus.move" }];
        }
        if (press.key.tab || press.key.upArrow) {
            return [{ direction: "previous", type: "focus.move" }];
        }
        if (press.key.downArrow) {
            return [{ direction: "next", type: "focus.move" }];
        }
        if (press.key.return) {
            return [{ type: "focus.activate" }];
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

    #forEditor(press: TuiKeyPress, _mode: "form" | "wizard"): TuiUiIntent[] {
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

    #forMainScopes(press: TuiKeyPress): TuiUiIntent[] {
        const instanceIndex = shiftedInstanceIndex(press);
        if (instanceIndex !== undefined) {
            return [{ index: instanceIndex, type: "instance.selectIndex" }];
        }
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
        if (press.input === "?") {
            return [{ type: "ui.help" }];
        }
        if (press.input === "r" || press.input === "R") {
            return [{ type: "page.reload" }];
        }
        return [];
    }
}

function isShortcutDigit(input: string): input is "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" {
    return input === "1" || input === "2" || input === "3" || input === "4" || input === "5" || input === "6" || input === "7" || input === "8" || input === "9";
}

function shiftedInstanceIndex(press: TuiKeyPress): number | undefined {
    if (press.key.shift && isShortcutDigit(press.input)) {
        return Number(press.input) - 1;
    }

    if (press.input.length !== 1) {
        return undefined;
    }
    const symbols = "!@#$%^&*()";
    const index = symbols.indexOf(press.input);
    return index === -1 ? undefined : index;
}
