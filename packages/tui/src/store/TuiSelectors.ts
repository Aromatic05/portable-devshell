import { focusItemKey, type FocusItem, type TuiMode } from "../interaction/TuiInteractionTypes.js";
import type { TuiAppState, TuiConnectionState, TuiPanel, TuiRawEventRecord } from "./TuiReducers.js";

const panels: Array<{ label: string; panel: TuiPanel }> = [
    { label: "Instances", panel: "instances" },
    { label: "Config", panel: "config" },
    { label: "Connector", panel: "connector" },
    { label: "Audit", panel: "audit" },
    { label: "Logs", panel: "logs" },
    { label: "Help", panel: "help" }
];

export function selectActivePanel(state: TuiAppState): TuiPanel {
    return state.activePanel;
}

export function selectConnectionState(state: TuiAppState): TuiConnectionState {
    return state.connection;
}

export function selectHeaderTitle(): string {
    return "portable-devshell tui";
}

export function selectHeaderSummary(state: TuiAppState): string {
    return `instances ${state.instances.length} | live ${state.globalDerived.connectedInstanceCount} | events ${state.globalDerived.totalEventCount}`;
}

export function selectSidebarItems(state: TuiAppState): Array<{ active: boolean; label: string; panel: TuiPanel }> {
    return panels.map((item) => ({
        active: item.panel === state.activePanel,
        label: item.label,
        panel: item.panel
    }));
}

export function selectInstanceRows(state: TuiAppState): string[] {
    if (state.instances.length === 0) {
        return ["No instances returned by control."];
    }

    return state.instances.map((instance) => {
        const snapshot = state.snapshotsByInstance[instance.name];
        const seq = state.lastSeqByInstance[instance.name] ?? snapshot?.lastSeq ?? 0;
        const status = snapshot === undefined ? "snapshot pending" : `${snapshot.status} / ${snapshot.connectionState}`;
        const mcp = instance.mcpEnabled ? "mcp:on" : "mcp:off";

        return `${instance.name}  ${status}  seq:${seq}  ${mcp}`;
    });
}

export function selectRecentEvents(state: TuiAppState, limit = 10): TuiRawEventRecord[] {
    return state.rawEvents.slice(Math.max(0, state.rawEvents.length - limit));
}

export function selectFooterText(state: TuiAppState): string {
    const prefix = `${state.connection.status} ${panelLabel(state.activePanel)} ${state.interaction.mode}`;
    const focus = state.interaction.currentFocus === undefined ? "focus none" : `focus ${focusLabel(state.interaction.currentFocus)}`;
    return `${prefix} | ${focus} | ${selectFooterShortcuts(state).join(" ")}`;
}

export function selectErrorMessage(state: TuiAppState): string[] | undefined {
    if (state.connection.errorCode === "control.notRunning") {
        return ["control server is not running.", "Start it first:", "  devshell start"];
    }

    if (typeof state.connection.errorMessage === "string" && state.connection.errorMessage.length > 0) {
        return [state.connection.errorMessage];
    }

    return undefined;
}

export function selectPanelTitle(panel: TuiPanel): string {
    return panelLabel(panel);
}

export function selectConfigLines(state: TuiAppState): string[] {
    if (state.configView === undefined) {
        return ["Config view unavailable."];
    }

    return JSON.stringify(state.configView, null, 2).split("\n");
}

export function selectConnectorLines(state: TuiAppState): string[] {
    return [
        `connection ${state.connection.status}`,
        `instances ${state.instances.length}`,
        "control RPC only",
        "no worker RPC"
    ];
}

export function selectAuditLines(state: TuiAppState): string[] {
    const events = selectRecentEvents(state, 8);

    if (events.length === 0) {
        return ["No control stream events received yet."];
    }

    return events.map((event) => `${event.instance} #${event.seq} ${event.event}`);
}

export function selectLogLines(state: TuiAppState): string[] {
    return ["logs placeholder", `events ${state.rawEvents.length}`];
}

export function selectHelpLines(): string[] {
    return ["ctrl+d quit", "ctrl+[ close", "1-6 panels", "[ ] cycle", "tab arrows move", "a menu", "/ search", "? help"];
}

export function selectFooterModel(state: TuiAppState): { mode: TuiMode; text: string } {
    return {
        mode: state.interaction.mode,
        text: selectFooterText(state)
    };
}

export function selectFooterShortcuts(state: TuiAppState): string[] {
    switch (state.interaction.mode) {
        case "actionMenu":
            return ["↑↓", "enter", "ctrl+["];
        case "confirm":
            return ["tab", "←→", "enter", "ctrl+["];
        case "search":
            return ["type", "bs", "enter", "ctrl+["];
        case "edit":
        case "normal": {
            const shortcuts = ["1-6", "[]", "tab", "↔", "enter"];

            if (canToggleCurrentFocus(state)) {
                shortcuts.push("sp");
            }

            shortcuts.push("a", "/", "?", "^[", "^D", "^L");
            return shortcuts;
        }
    }
}

export function selectActionMenuModel(state: TuiAppState): { items: Array<{ active: boolean; id: string; label: string }>; open: boolean; title: string } {
    const focused = state.interaction.currentFocus;

    return {
        items: state.interaction.actionMenu.items.map((item) => ({
            active: focused?.kind === "action" && focused.id === item.id,
            id: item.id,
            label: item.label
        })),
        open: state.interaction.actionMenu.open,
        title: state.interaction.actionMenu.title
    };
}

export function selectConfirmDialogModel(state: TuiAppState): {
    body: string;
    confirmFocused: boolean;
    confirmLabel: string;
    open: boolean;
    cancelFocused: boolean;
    cancelLabel: string;
    title: string;
} {
    return {
        body: state.interaction.confirmDialog.body,
        cancelFocused: state.interaction.currentFocus?.kind === "button" && state.interaction.currentFocus.id === "cancel",
        cancelLabel: state.interaction.confirmDialog.cancelLabel,
        confirmFocused: state.interaction.currentFocus?.kind === "button" && state.interaction.currentFocus.id === "confirm",
        confirmLabel: state.interaction.confirmDialog.confirmLabel,
        open: state.interaction.confirmDialog.open,
        title: state.interaction.confirmDialog.title
    };
}

export function selectSearchModel(state: TuiAppState): { open: boolean; query: string } {
    return {
        open: state.interaction.search.open,
        query: state.interaction.search.query
    };
}

function panelLabel(panel: TuiPanel): string {
    return panels.find((item) => item.panel === panel)?.label ?? panel;
}

function focusLabel(item: FocusItem): string {
    const compactId = item.id.includes(".") ? item.id.split(".").at(-1) ?? item.id : item.id;
    return `${item.kind}:${compactId}`;
}

function canToggleCurrentFocus(state: TuiAppState): boolean {
    const currentFocus = state.interaction.currentFocus;

    if (currentFocus === undefined) {
        return false;
    }

    if (state.activePanel !== "config") {
        return true;
    }

    return currentFocus.kind === "field";
}
