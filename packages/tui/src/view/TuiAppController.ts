import type { TuiAppState } from "../state/reducer/TuiStoreModel.js";
import type { TuiTerminalRenderSource } from "./component/TuiComponentTerminal.js";

export interface TuiAppKey {
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
}

export interface TuiAppRenderSource {
    getSnapshot(): TuiAppState;
    subscribe(listener: () => void): () => void;
}

export interface TuiAppController {
    readonly columns: number;
    readonly rows: number;
    readonly scheduler: TuiAppRenderSource;
    readonly terminal: TuiTerminalRenderSource;
    handleInput(input: string, key: TuiAppKey): Promise<void>;
    openTerminal(instance: string | undefined, columns: number, rows: number): Promise<void>;
    renderTextDetailImage(visible: boolean): void;
    renderTerminalGraphics(visible: boolean): void;
}
