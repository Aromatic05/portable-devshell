import type { TuiPageId } from "./TuiUiState.js";

const orderedPages: readonly TuiPageId[] = ["instances", "config", "connector", "oauth", "audit", "logs", "todo", "help"];

export function pageFromShortcut(index: number): TuiPageId | undefined {
    return orderedPages[index - 1];
}
