import type { TuiAppState } from "../store/Model.js";
import { currentTuiRoute } from "./State.js";

export function buildHelpLines(state: TuiAppState): string[] {
    return [
        `Current page ${state.ui.selectedPage}`,
        `Selected instance ${state.ui.selectedInstance ?? "none"}`,
        "Instance lifecycle actions are available directly inside each expanded instance box.",
        "Tab cycles sidebar and main boxes.",
        "Up/Down moves sidebar focus without selecting.",
        "Enter applies the focused sidebar item.",
        "Space expands and collapses the focused box.",
        "Esc returns from detail, search, menus, and main focus.",
        "Ctrl+[ remains available as a terminal-safe escape fallback.",
    ];
}

export function buildContextualHelpLines(state: TuiAppState): string[] {
    const route = currentTuiRoute(state);
    const pageLines: Record<TuiAppState["ui"]["selectedPage"], string[]> = {
        overview: [
            "Enter opens the focused Instance.",
            "r refreshes the overview; / searches visible data.",
        ],
        instances: [
            "Enter opens the focused item; Space expands actions and details.",
            "Lifecycle actions are inside the expanded Instance.",
        ],
        config: [
            "Enter edits the focused field.",
            "Ctrl+S saves; Ctrl+D discards local edits.",
        ],
        connections: [
            "Enter opens the focused connection or action.",
            "Editable connection fields use Ctrl+S to save.",
        ],
        messages: [
            "Use Active / History in the upper sidebar to choose Messages.",
            "Enter opens a Message; type in the composer and Enter sends.",
        ],
        audit: [
            "Enter opens the focused Context or Tool Call; Space expands details.",
            "M opens the Message for a concrete Context; / searches Audit.",
        ],
        goals: [
            "Space expands the selected final Goal and its status.",
        ],
        extensions: [
            "Enter opens an Extension-provided terminal page.",
            "Extension actions use the same focus and confirmation behavior as native pages.",
        ],
        help: [
            "This page contains the complete navigation and action reference.",
        ],
        terminal: [
            "Right/Tab enters the terminal; Ctrl+] returns to the sidebar.",
            "Ctrl+T switches terminal sources; Shift+PgUp/PgDn browses scrollback.",
        ],
    };
    return [
        `Page: ${state.ui.selectedPage}`,
        `Instance: ${state.ui.selectedInstance ?? "none"}`,
        `View: ${route.view}`,
        "",
        ...pageLines[state.ui.selectedPage],
        "",
        "Esc closes this help and returns to the same location.",
        "Open the Help page for the complete reference.",
    ];
}
