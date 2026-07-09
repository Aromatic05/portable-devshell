import type { TuiAppState, TuiConnectionState, TuiInstanceListEntry, TuiPanel, TuiRawEventRecord } from "./TuiReducers.js";

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
    return `instances ${state.instances.length} | connected ${state.globalDerived.connectedInstanceCount} | events ${state.globalDerived.totalEventCount}`;
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
    return `state ${state.connection.status} | panel ${panelLabel(state.activePanel)} | ↑↓ switch | 1-6 jump | r reconnect | q quit`;
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
        `Connection state: ${state.connection.status}`,
        `Control instances: ${state.instances.length}`,
        "Prompt 1 scope: control RPC only.",
        "No worker RPC, attach shell, or config editing."
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
    return [
        "Prompt 1 does not read worker log files.",
        `Buffered control events: ${state.rawEvents.length}`
    ];
}

export function selectHelpLines(): string[] {
    return ["q quit", "r reconnect control session", "up/down move sidebar selection", "1-6 jump to panel"];
}

function panelLabel(panel: TuiPanel): string {
    return panels.find((item) => item.panel === panel)?.label ?? panel;
}
