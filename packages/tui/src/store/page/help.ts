import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState } from "../TuiReducers.js";
import { makeBox } from "./PageBoxSupport.js";

export function buildHelpLines(state: TuiAppState): string[] {
    return [
        `Current page ${state.ui.selectedPage}`,
        `Selected instance ${state.ui.selectedInstance ?? "none"}`,
        "Read-only until an explicit instance action is chosen from the action menu.",
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
                "Ctrl+[ returns from detail, search, menus, and main focus."
            ],
            id: "help-navigation",
            status: "normal",
            summaryLines: ["navigation shortcuts", "scope cycling"],
            title: "Navigation"
        }),
        makeBox(state, "help", undefined, {
            detailLines: [
                "Use a to open explicit actions for the selected instance.",
                "Stop Worker always opens a confirmation dialog with Cancel focused.",
                "Approval detail offers Approve, Deny, and Back; Enter never approves a list item.",
                "Create and save actions remain unavailable."
            ],
            id: "help-readonly",
            status: "disabled",
            summaryLines: ["explicit action boundaries", "no automatic worker start"],
            title: "Action Boundaries"
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
