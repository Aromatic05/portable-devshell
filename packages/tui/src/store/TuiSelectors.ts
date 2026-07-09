import type { ApprovalRequest, JsonValue, ToolCallRecord } from "@portable-devshell/shared";

import { focusItemKey, type FocusItem, type TuiMode } from "../interaction/TuiInteractionTypes.js";
import type { TuiAppState, TuiConnectionState, TuiLogEntry, TuiPanel, TuiRawEventRecord } from "./TuiReducers.js";

const panels: Array<{ label: string; panel: TuiPanel }> = [
    { label: "Instances", panel: "instances" },
    { label: "Connector", panel: "connector" },
    { label: "Audit", panel: "audit" },
    { label: "Logs", panel: "logs" },
    { label: "Approvals", panel: "approvals" },
    { label: "Help", panel: "help" }
];

export interface TuiCardLine {
    expandable?: boolean;
    id?: string;
    text: string;
}

export interface TuiAuditCard {
    expanded: boolean;
    id: string;
    lines: TuiCardLine[];
}

export interface TuiLogViewportModel {
    atBottom: boolean;
    follow: boolean;
    lines: string[];
    topIndex: number;
    totalLines: number;
}

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
    return `instances ${state.instances.length} | live ${state.globalDerived.connectedInstanceCount} | approvals ${state.globalDerived.pendingApprovalCount} | events ${state.globalDerived.totalEventCount}`;
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
        return ["No instances returned by control/config."];
    }

    return state.instances.map((instance) => {
        const snapshot = state.snapshotsByInstance[instance.name];
        const daemonState = snapshot?.daemonState ?? "unknown";
        const connectionState = snapshot?.connectionState ?? "unknown";
        const ready = snapshot?.ready === true ? "yes" : "no";
        const pending = (state.approvalsByInstance[instance.name] ?? []).filter((approval) => approval.status === "pending").length;
        const running = (state.toolCallsByInstance[instance.name] ?? []).filter(
            (record) => record.status === "running" || record.status === "pendingApproval"
        );
        const lastErrorCode = snapshot?.lastErrorCode ?? "none";
        const lastErrorMessage = selectLastErrorMessage(state, instance.name) ?? "n/a";

        return [
            instance.name,
            `enabled:${instance.enabled ? "yes" : "no"}`,
            `provider:${instance.provider ?? "unknown"}`,
            `workspace:${instance.defaultWorkspace ?? "-"}`,
            `daemon:${daemonState}`,
            `conn:${connectionState}`,
            `ready:${ready}`,
            `mcp:${instance.mcpEnabled ? "on" : "off"}${instance.mcpPath === undefined ? "" : ` ${instance.mcpPath}`}`,
            `pending:${pending}`,
            `running:${running.length === 0 ? "-" : running.map((record) => `${record.toolName}:${record.status}`).join(",")}`,
            `error:${lastErrorCode}/${lastErrorMessage}`
        ].join("  ");
    });
}

export function selectInstanceDetailLines(state: TuiAppState): string[] {
    const instance = selectFocusedInstance(state);

    if (instance === undefined) {
        return ["Select an instance to inspect runtime/workspace/MCP/audit/logs/approvals."];
    }

    const snapshot = state.snapshotsByInstance[instance.name];
    const toolCalls = state.toolCallsByInstance[instance.name] ?? [];
    const logs = state.logsByInstance[instance.name] ?? [];
    const approvals = (state.approvalsByInstance[instance.name] ?? []).filter((approval) => approval.status === "pending");

    return [
        `Runtime`,
        `daemonState ${snapshot?.daemonState ?? "unknown"}`,
        `connectionState ${snapshot?.connectionState ?? "unknown"}`,
        `ready ${snapshot?.ready === true ? "true" : "false"}`,
        `lastSeq ${state.lastSeqByInstance[instance.name] ?? snapshot?.lastSeq ?? 0}`,
        `last status change ${state.lastStatusChangeAtByInstance[instance.name] ?? "unavailable"}`,
        `Workspace`,
        `${instance.defaultWorkspace ?? "unavailable"}`,
        `MCP`,
        `enabled ${instance.mcpEnabled ? "true" : "false"}`,
        `path ${instance.mcpPath ?? "unavailable"}`,
        `Recent Tool Calls`,
        ...(toolCalls.length === 0 ? ["none"] : toolCalls.slice(0, 3).map((record) => `${record.toolName} ${record.status} ${record.callId}`)),
        `Recent Logs`,
        ...(logs.length === 0 ? ["none"] : logs.slice(-3).map((entry) => `${entry.stream} #${entry.seq} ${renderLogMessage(entry)}`)),
        `Pending Approvals`,
        ...(approvals.length === 0 ? ["none"] : approvals.slice(0, 3).map((approval) => `${approval.toolName} ${approval.approvalId} ${approval.riskLevel}`))
    ];
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
        return ["control server is not running.", "No instance is auto-started.", "Run `devshell start` manually if needed."];
    }

    if (typeof state.connection.errorMessage === "string" && state.connection.errorMessage.length > 0) {
        return [state.connection.errorMessage];
    }

    return undefined;
}

export function selectPanelTitle(panel: TuiPanel): string {
    return panelLabel(panel);
}

export function selectConnectorLines(state: TuiAppState): string[] {
    const mcp = asRecord(state.configView?.mcp);
    const auth = asRecord(mcp?.auth);
    const instanceLines = state.instances.map((instance) => `instance ${instance.name} mcp.path ${instance.mcpPath ?? "unavailable"}`);

    return [
        "Config Preview",
        `mcp.enabled ${mcp?.enabled === true ? "true" : "false"}`,
        `listenHost ${typeof mcp?.listenHost === "string" ? mcp.listenHost : "unavailable"}`,
        `listenPort ${typeof mcp?.listenPort === "number" ? String(mcp.listenPort) : "unavailable"}`,
        `publicBaseUrl ${typeof mcp?.publicBaseUrl === "string" ? mcp.publicBaseUrl : "unavailable"}`,
        `auth.mode ${typeof auth?.mode === "string" ? auth.mode : "unavailable"}`,
        ...instanceLines,
        `endpoint preview ${buildEndpointPreview(mcp)}`,
        `validation warning ${buildValidationWarning(mcp)}`,
        "Runtime Status Not Available",
        "No public.status/oauth.status/endpoint health is exposed here."
    ];
}

export function selectAuditCards(state: TuiAppState): TuiAuditCard[] {
    const records = Object.values(state.toolCallsByInstance)
        .flatMap((value) => value)
        .sort(compareToolCalls);

    if (records.length === 0) {
        return [
            {
                expanded: false,
                id: "audit.empty",
                lines: [{ text: "No tool call history from instance.readToolCalls or stream events." }]
            }
        ];
    }

    return records.map((record) => {
        const id = `audit.${record.instance}.${record.callId}`;
        const expanded = state.interaction.expandedByKey[id] === true;
        const summary = `${record.instance} ${record.toolName} ${record.status} ${record.callId}`;
        const lines: TuiCardLine[] = [{ expandable: true, id, text: summary }];

        if (expanded) {
            lines.push(
                { text: `callId ${record.callId}` },
                { text: `instance ${record.instance}` },
                { text: `source ${record.source}` },
                { text: `sessionId ${record.sessionId ?? "-"}` },
                { text: `requestId ${record.requestId ?? "-"}` },
                { text: `toolName ${record.toolName}` },
                { text: `input ${record.inputSummary || "-"}` },
                { text: `startedAt ${record.startedAt}` },
                { text: `completedAt ${record.completedAt ?? "-"}` },
                { text: `status ${record.status}` },
                { text: `timedOut ${record.timedOut ? "true" : "false"}` },
                { text: `exitCode ${record.exitCode ?? "-"}` },
                { text: `stdoutBytes ${record.stdoutBytes ?? "-"}` },
                { text: `stderrBytes ${record.stderrBytes ?? "-"}` },
                { text: `error ${record.error ?? "-"}` },
                { text: "approve/deny disabled in Prompt 3 read-only mode" }
            );
        }

        return { expanded, id, lines };
    });
}

export function selectAuditLines(state: TuiAppState): string[] {
    return selectAuditCards(state).flatMap((card) => card.lines.map((line) => line.text));
}

export function selectLogViewport(state: TuiAppState, maxVisibleLines = 14): TuiLogViewportModel {
    const query = state.interaction.search.query.toLowerCase();
    const lines = Object.entries(state.logsByInstance)
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([, entries]) => entries)
        .map((entry) => `${entry.instance} ${entry.stream} #${entry.seq} ${renderLogMessage(entry)}`)
        .filter((line) => query.length === 0 || line.toLowerCase().includes(query));

    if (lines.length === 0) {
        return {
            atBottom: true,
            follow: state.interaction.logsViewport.follow,
            lines: ["No logs loaded yet."],
            topIndex: 0,
            totalLines: 1
        };
    }

    const totalLines = lines.length;
    const maxTopIndex = Math.max(0, totalLines - maxVisibleLines);
    const topIndex = state.interaction.logsViewport.follow ? maxTopIndex : Math.min(state.interaction.logsViewport.topIndex, maxTopIndex);

    return {
        atBottom: topIndex >= maxTopIndex,
        follow: state.interaction.logsViewport.follow,
        lines: lines.slice(topIndex, topIndex + maxVisibleLines),
        topIndex,
        totalLines
    };
}

export function selectLogLines(state: TuiAppState): string[] {
    const viewport = selectLogViewport(state);
    return [
        `logs ${viewport.totalLines} follow:${viewport.follow ? "on" : "off"} top:${viewport.topIndex}`,
        ...viewport.lines
    ];
}

export function selectApprovalCards(state: TuiAppState): TuiAuditCard[] {
    const approvals = Object.values(state.approvalsByInstance)
        .flatMap((value) => value)
        .filter((approval) => approval.status === "pending")
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    if (approvals.length === 0) {
        return [
            {
                expanded: false,
                id: "approvals.empty",
                lines: [{ text: "No pending approvals." }]
            }
        ];
    }

    return approvals.map((approval) => {
        const id = `approval.${approval.instance}.${approval.approvalId}`;
        const expanded = state.interaction.expandedByKey[id] === true;
        const lines: TuiCardLine[] = [
            {
                expandable: true,
                id,
                text: `${approval.approvalId} ${approval.instance} ${approval.toolName} ${approval.source} ${approval.riskLevel}`
            }
        ];

        if (expanded) {
            lines.push(
                { text: `summary ${approval.inputSummary || "-"}` },
                { text: `createdAt ${approval.createdAt}` },
                { text: `expiresAt ${approval.expiresAt}` },
                { text: `status ${approval.status}` },
                { text: "approve/deny disabled in Prompt 3 read-only mode" }
            );
        }

        return { expanded, id, lines };
    });
}

export function selectApprovalLines(state: TuiAppState): string[] {
    return selectApprovalCards(state).flatMap((card) => card.lines.map((line) => line.text));
}

export function selectHelpLines(state: TuiAppState): string[] {
    const shortcuts = selectFooterShortcuts(state).join(" ");
    const panel = state.activePanel;

    return [
        `Mode ${state.interaction.mode}`,
        `Panel ${panelLabel(panel)}`,
        `Shortcuts ${shortcuts}`,
        "Read-only cockpit. No start/stop/callTool/approve/deny/save/create actions are available.",
        "Instances: Up/Down select, Enter focus detail only, Space expand/collapse card, a opens placeholder menu, / search.",
        "Audit: Enter/Space expand tool call card, action menu only shows disabled note.",
        "Logs: Up/Down scroll, PageUp/PageDown/Home/End move viewport, r reload, f follow toggle, c clear UI buffer only.",
        "Approvals: Enter/Space expand pending approval card, no approve/deny.",
        "Connector: config preview only; runtime endpoint/public/oauth status is unavailable."
    ];
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
            const shortcuts = ["1-6", "[]", "tab", "↕", "enter", "sp", "a", "/", "?"];

            if (state.activePanel === "logs") {
                shortcuts.push("PgUp/PgDn", "Home/End", "r", "f", "c");
            }

            shortcuts.push("^[", "^D", "^L");
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

export function selectExpanded(state: TuiAppState, key: string): boolean {
    return state.interaction.expandedByKey[key] === true;
}

function panelLabel(panel: TuiPanel): string {
    return panels.find((item) => item.panel === panel)?.label ?? panel;
}

function focusLabel(item: FocusItem): string {
    return focusItemKey(item);
}

function selectFocusedInstance(state: TuiAppState) {
    const focus = state.interaction.currentFocus;

    if (focus?.kind !== "listItem" || !focus.id.startsWith("instances.row.")) {
        return state.instances[0];
    }

    const index = Number(focus.id.slice("instances.row.".length));
    return Number.isFinite(index) ? state.instances[index] : state.instances[0];
}

function selectLastErrorMessage(state: TuiAppState, instanceName: string): string | undefined {
    const records = state.toolCallsByInstance[instanceName] ?? [];
    return records.find((record) => typeof record.error === "string" && record.error.length > 0)?.error;
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function buildEndpointPreview(mcp: Record<string, JsonValue> | undefined): string {
    if (mcp?.enabled !== true) {
        return "mcp disabled";
    }

    const host = typeof mcp.listenHost === "string" ? mcp.listenHost : "127.0.0.1";
    const port = typeof mcp.listenPort === "number" ? String(mcp.listenPort) : "unavailable";
    return `http://${host}:${port}/<instance>/mcp`;
}

function buildValidationWarning(mcp: Record<string, JsonValue> | undefined): string {
    if (mcp?.enabled !== true) {
        return "none";
    }

    return typeof mcp.publicBaseUrl === "string" ? "none" : "publicBaseUrl missing; public endpoint preview may be incomplete";
}

function compareToolCalls(left: ToolCallRecord, right: ToolCallRecord): number {
    const startedAt = right.startedAt.localeCompare(left.startedAt);

    if (startedAt !== 0) {
        return startedAt;
    }

    return right.callId.localeCompare(left.callId);
}

function renderLogMessage(entry: TuiLogEntry): string {
    return entry.message ?? entry.tail ?? entry.preview ?? "";
}
