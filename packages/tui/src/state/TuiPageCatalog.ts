import type { TuiPageId } from "./TuiUiState.js";

export interface TuiPageEntry {
    id: TuiPageId;
    label: string;
}

export const tuiPageEntries: readonly TuiPageEntry[] = [
    { id: "overview", label: "overview" },
    { id: "instances", label: "instances" },
    { id: "config", label: "config" },
    { id: "connections", label: "connections" },
    { id: "audit", label: "audit" },
    { id: "logs", label: "logs" },
    { id: "todo", label: "todo" },
    { id: "help", label: "help" },
    { id: "terminal", label: "terminal" }
];

export const tuiPageOrder: readonly TuiPageId[] = tuiPageEntries.map((entry) => entry.id);

export const tuiShortcutPages: readonly TuiPageId[] = [
    "instances",
    "config",
    "connections",
    "audit",
    "logs",
    "todo",
    "help",
    "terminal"
];

const searchablePages = new Set<TuiPageId>([
    "overview",
    "instances",
    "todo",
    "config",
    "audit",
    "logs"
]);

export function isTuiSearchablePage(page: TuiPageId): boolean {
    return searchablePages.has(page);
}

export function tuiPageShortcut(page: TuiPageId): string | undefined {
    if (page === "overview") {
        return "0";
    }
    const index = tuiShortcutPages.indexOf(page);
    return index < 0 ? undefined : String(index + 1);
}
