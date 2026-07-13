import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState } from "../TuiReducers.js";
import { makeBox } from "./PageBoxSupport.js";

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
        "Ctrl+[ remains available as a terminal-safe escape fallback."
    ];
}

export function buildHelpPageBoxes(state: TuiAppState): BoxModel[] {
    return [
        makeBox(state, "help", undefined, {
            detailLines: [
                "Tab cycles sidebar and main boxes.",
                "Shift+Tab reverses that cycle.",
                "Up/Down moves sidebar focus without selecting.",
                "Enter selects the focused item or activates its action.",
                "Space expands or collapses the focused box.",
                "1-8 switch pages; Shift+1-0 switch instances.",
                "r reloads the current page and / opens search where available.",
                "? opens this page; Ctrl+[ returns from detail, search, menus, and main focus."
            ],
            id: "help-navigation",
            status: "normal",
            summaryLines: ["navigation shortcuts", "scope cycling"],
            title: "Navigation"
        }),
        makeBox(state, "help", undefined, {
            detailLines: [
                "Expand an instance to create, attach, start, restart, stop, or delete.",
                "Configuration and Connector fields can be edited and saved with Ctrl+S.",
                "Stop, delete, and other destructive actions open a confirmation dialog with Cancel focused.",
                "Approval detail starts with Back focused; Enter never approves a list item."
            ],
            id: "help-readonly",
            status: "normal",
            summaryLines: ["explicit actions and confirmations", "create and save are available"],
            title: "Actions & Safety"
        }),
        makeBox(state, "help", undefined, {
            detailLines: buildHelpLines(state),
            id: "help-context",
            status: "normal",
            summaryLines: [`current page ${state.ui.selectedPage}`, `selected instance ${state.ui.selectedInstance ?? "none"}`],
            title: "Context"
        })
    ];
}
