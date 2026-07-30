import { tuiShortcutPages } from "./TuiPageCatalog.js";
import type { TuiPageId } from "./TuiUiState.js";

export function pageFromShortcut(index: number): TuiPageId | undefined {
    if (index === 0) {
        return "overview";
    }
    return tuiShortcutPages[index - 1];
}
