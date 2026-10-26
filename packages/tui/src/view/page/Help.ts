import type { BoxModel } from "../../layout/Box.js";
import type { TuiAppState } from "../../state/store/Model.js";
import { buildHelpLines } from "../../state/route/Help.js";
import { makeBox } from "./Support.js";

export { buildHelpLines, buildContextualHelpLines } from "../../state/route/Help.js";

export function buildHelpPageBoxes(state: TuiAppState): BoxModel[] {
    return [
        makeBox(state, "help", undefined, {
            detailLines: [
                "Tab cycles sidebar and main boxes.",
                "Shift+Tab reverses that cycle.",
                "Up/Down moves sidebar focus without selecting.",
                "Enter selects the focused item or activates its action.",
                "Space expands or collapses the focused box.",
                "0 opens Overview; 1-9 open feature pages; Shift+1-9 switch instances.",
                "Overview is read-only and prioritizes alerts, unhealthy instances, recent activity, and Workspace Goals.",
                "Terminal uses the selected instance; Right/Tab enters it, Ctrl+T switches Instances/Tmux Panes, and Ctrl+] returns to the sidebar. From the sidebar, K confirms and kills the persistent PTY; leaving the page only detaches.",
                "Terminal: drag selects and copies with OSC 52; hold Shift when the application owns mouse input.",
                "Terminal: Shift+PgUp/PgDn and Shift+Home/End browse scrollback; Esc closes the current tmux pane view; bracketed paste is preserved.",
                "Kitty and Sixel images are replayed when the host terminal advertises support; DEVSHELL_TUI_GRAPHICS overrides detection.",
                "On an Audit Context, M/m opens the Comment message; expand Write Comment, select Draft, Enter edits, and Enter sends.",
                "r reloads the current page and / opens search where available.",
                "? opens contextual help without leaving the current page; Ctrl+[ returns from detail, search, menus, and main focus.",
            ],
            id: "help-navigation",
            status: "normal",
            summaryLines: ["navigation shortcuts", "scope cycling"],
            title: "Navigation",
        }),
        makeBox(state, "help", undefined, {
            detailLines: [
                "On Instances, Enter on Create Instance opens the wizard; Space shows provider details. Expand an existing instance to attach, start, restart, stop, or delete.",
                "Configuration and Connections fields can be edited and saved with Ctrl+S.",
                "Stop, delete, and other destructive actions open a confirmation dialog with Cancel focused.",
                "Approval detail starts with Back focused; Enter never approves a list item.",
            ],
            id: "help-readonly",
            status: "normal",
            summaryLines: [
                "explicit actions and confirmations",
                "create and save are available",
            ],
            title: "Actions & Safety",
        }),
        makeBox(state, "help", undefined, {
            detailLines: buildHelpLines(state),
            id: "help-context",
            status: "normal",
            summaryLines: [
                `current page ${state.ui.selectedPage}`,
                `selected instance ${state.ui.selectedInstance ?? "none"}`,
            ],
            title: "Context",
        }),
    ];
}
