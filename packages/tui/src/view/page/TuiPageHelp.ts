import type { BoxModel } from "../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import { currentTuiRoute } from "../../state/route/TuiRouteState.js";
import { makeBox } from "./TuiPageBoxSupport.js";

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
        overview: ["Enter opens the focused Instance.", "r refreshes the overview; / searches visible data."],
        instances: ["Enter opens the focused item; Space expands actions and details.", "Lifecycle actions are inside the expanded Instance."],
        config: ["Enter edits the focused field.", "Ctrl+S saves; Ctrl+D discards local edits."],
        connections: ["Enter opens the focused connection or action.", "Editable connection fields use Ctrl+S to save."],
        messages: ["Use Active / History in the upper sidebar to choose Conversations.", "Enter opens a Conversation; type in the composer and Enter sends."],
        audit: ["Enter opens the focused Context or Tool Call; Space expands details.", "M opens the Conversation for a concrete Context; / searches Audit."],
        logs: ["Enter opens the focused log Context; Space expands details.", "r refreshes and / searches logs."],
        todo: ["Enter opens the focused Todo; Space expands details.", "Destructive actions require confirmation."],
        help: ["This page contains the complete navigation and action reference."],
        terminal: ["Right/Tab enters the terminal; Ctrl+] returns to the sidebar.", "Ctrl+T switches terminal sources; Shift+PgUp/PgDn browses scrollback."],
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
                "Overview is read-only and prioritizes alerts, unhealthy instances, recent activity, and actionable todos.",
                "Terminal uses the selected instance; Right/Tab enters it, Ctrl+T switches Instances/Tmux Panes, and Ctrl+] returns to the sidebar. From the sidebar, K confirms and kills the persistent PTY; leaving the page only detaches.",
                "Terminal: drag selects and copies with OSC 52; hold Shift when the application owns mouse input.",
                "Terminal: Shift+PgUp/PgDn and Shift+Home/End browse scrollback; Esc closes the current tmux pane view; bracketed paste is preserved.",
                "Kitty and Sixel images are replayed when the host terminal advertises support; DEVSHELL_TUI_GRAPHICS overrides detection.",
                "On an Audit Context, M/m opens the Comment conversation; expand Write Comment, select Draft, Enter edits, and Enter sends.",
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
