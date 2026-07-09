import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState } from "../TuiReducers.js";
import { makeBox } from "./PageBoxSupport.js";

export function buildHelpLines(state: TuiAppState): string[] {
    return [
        `Current page ${state.ui.selectedPage}`,
        `Selected instance ${state.ui.selectedInstance ?? "none"}`,
        "Read-only cockpit. No start/stop/approve/deny/call tool/attach shell/create/save actions are available.",
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
                "No start/stop worker actions.",
                "No approve/deny actions.",
                "No call tool, attach shell, create, or save actions."
            ],
            id: "help-readonly",
            status: "disabled",
            summaryLines: ["read-only boundaries", "state-changing actions disabled"],
            title: "Read-only Boundaries"
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
