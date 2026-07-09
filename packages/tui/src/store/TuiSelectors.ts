import type { ApprovalRequest, JsonValue, ToolCallRecord } from "@portable-devshell/shared";

import { measureExpandableBoxHeight, type BoxLine, type BoxModel } from "../component/ExpandableBox.js";
import type { TuiMode } from "../interaction/TuiInteractionTypes.js";
import type { ActivePage, ExpandableBoxStatus, PageId } from "../model/TuiUiTypes.js";
import type { TuiAppState, TuiConnectionState, TuiInstanceListEntry, TuiLogEntry } from "./TuiReducers.js";

const pageEntries: Array<{ id: PageId; label: string }> = [
    { id: "instances", label: "instances" },
    { id: "config", label: "config" },
    { id: "connector", label: "connector" },
    { id: "audit", label: "audit" },
    { id: "logs", label: "logs" },
    { id: "help", label: "help" }
];

export interface SidebarEntry {
    focused: boolean;
    id: string;
    label: string;
    selected: boolean;
}

export interface SidebarModel {
    instances: SidebarEntry[];
    pages: SidebarEntry[];
}

export interface MainScreenModel {
    activePage: ActivePage;
    boxes: BoxModel[];
    emptyState?: string;
    pageTitle: string;
    statusLine?: string;
}

export interface MainBoxFlowMetrics {
    boxRanges: Record<string, { end: number; start: number }>;
    scrollKey: string;
    totalLines: number;
}

export function selectActivePage(state: TuiAppState): ActivePage {
    return {
        instance: state.ui.selectedInstance,
        page: state.ui.selectedPage
    };
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

export function selectSidebarModel(state: TuiAppState): SidebarModel {
    const cursor = state.interaction.sidebarCursor;
    const sidebarFocused = state.interaction.focusScope === "sidebarPages" || state.interaction.focusScope === "sidebarInstances";

    return {
        instances: state.instances.map((instance) => ({
            focused: sidebarFocused && cursor?.kind === "instance" && cursor.id === instance.name,
            id: instance.name,
            label: instance.name,
            selected: state.ui.selectedInstance === instance.name
        })),
        pages: pageEntries.map((page) => ({
            focused: sidebarFocused && cursor?.kind === "page" && cursor.id === page.id,
            id: page.id,
            label: page.label,
            selected: state.ui.selectedPage === page.id
        }))
    };
}

export function selectMainScreenModel(state: TuiAppState): MainScreenModel {
    const activePage = selectActivePage(state);
    const statusLine = state.interaction.screenStatusByPage[activePage.page];

    if (activePage.page !== "help" && activePage.instance === undefined) {
        return {
            activePage,
            boxes: [],
            emptyState: "No instance selected. Select one from the lower sidebar list.",
            pageTitle: pageTitle(activePage.page),
            statusLine
        };
    }

    return {
        activePage,
        boxes: buildBoxesForPage(state, activePage.page, activePage.instance),
        pageTitle: pageTitle(activePage.page),
        statusLine
    };
}

export function selectMainBoxIds(state: TuiAppState): string[] {
    return selectMainScreenModel(state).boxes.map((box) => box.id);
}

export function selectMainBoxFlowMetrics(state: TuiAppState): MainBoxFlowMetrics {
    const model = selectMainScreenModel(state);
    let cursor = 0;
    const boxRanges: Record<string, { end: number; start: number }> = {};

    for (const box of model.boxes) {
        const start = cursor;
        cursor += measureExpandableBoxHeight(box);
        boxRanges[box.id] = { end: cursor, start };
    }

    return {
        boxRanges,
        scrollKey: selectMainScrollKey(state),
        totalLines: cursor
    };
}

export function selectMainScrollKey(state: TuiAppState): string {
    return `${state.ui.selectedPage}:${state.ui.selectedInstance ?? "-"}:main`;
}

export function selectFooterModel(state: TuiAppState): { mode: TuiMode; text: string } {
    return {
        mode: state.interaction.focusScope,
        text: selectFooterText(state)
    };
}

export function selectFooterText(state: TuiAppState): string {
    const active = selectActivePage(state);
    const scope = state.interaction.focusScope;
    const instance = active.instance ?? "none";
    return `${state.connection.status} ${active.page}:${instance} ${scope} | ${selectFooterShortcuts(state).join(" ")}`;
}

export function selectFooterShortcuts(state: TuiAppState): string[] {
    switch (state.interaction.focusScope) {
        case "sidebarPages":
        case "sidebarInstances":
            return ["tab", "enter", "1-6", "↑↓", "esc"];
        case "mainBoxes":
            return ["tab", "enter", "space", "↑↓", "/", "a", "esc"];
        case "boxDetail":
            return ["enter", "↑↓", "/", "esc"];
        case "search":
            return ["type", "bs", "enter", "esc"];
        case "actionMenu":
            return ["↑↓", "enter", "esc"];
        case "confirm":
            return ["tab", "←→", "enter", "esc"];
    }
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

export function selectActionMenuModel(state: TuiAppState): { items: Array<{ active: boolean; id: string; label: string }>; open: boolean; title: string } {
    return {
        items: state.interaction.actionMenu.items.map((item) => ({
            active: state.interaction.selectedActionId === item.id,
            id: item.id,
            label: item.label
        })),
        open: state.interaction.actionMenu.open,
        title: state.interaction.actionMenu.title
    };
}

export function selectConfirmDialogModel(state: TuiAppState): {
    body: string;
    cancelFocused: boolean;
    cancelLabel: string;
    confirmFocused: boolean;
    confirmLabel: string;
    open: boolean;
    title: string;
} {
    return {
        body: state.interaction.confirmDialog.body,
        cancelFocused: state.interaction.selectedConfirmButton === "cancel",
        cancelLabel: state.interaction.confirmDialog.cancelLabel,
        confirmFocused: state.interaction.selectedConfirmButton === "confirm",
        confirmLabel: state.interaction.confirmDialog.confirmLabel,
        open: state.interaction.confirmDialog.open,
        title: state.interaction.confirmDialog.title
    };
}

export function selectSearchModel(state: TuiAppState): { open: boolean; query: string } {
    return {
        open: state.interaction.search.open,
        query: state.ui.searchQueries[state.ui.selectedPage] ?? ""
    };
}

export function selectExpanded(state: TuiAppState, key: string): boolean {
    return state.ui.expandedBoxes[key] === true;
}

export function selectHelpLines(state: TuiAppState): string[] {
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

function buildBoxesForPage(state: TuiAppState, page: PageId, instanceName: string | undefined): BoxModel[] {
    if (page === "help") {
        return [
            makeBox(state, page, instanceName, {
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
            makeBox(state, page, instanceName, {
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
            makeBox(state, page, instanceName, {
                detailLines: selectHelpLines(state),
                id: "help-context",
                status: "normal",
                summaryLines: [`current page ${state.ui.selectedPage}`, `selected instance ${state.ui.selectedInstance ?? "none"}`],
                title: "Context"
            })
        ];
    }

    if (instanceName === undefined) {
        return [];
    }

    const instance = state.instances.find((entry) => entry.name === instanceName);
    const snapshot = state.snapshotsByInstance[instanceName];
    const config = readConfigInstance(state, instanceName);
    const logs = state.logsByInstance[instanceName] ?? [];
    const toolCalls = state.toolCallsByInstance[instanceName] ?? [];
    const approvals = (state.approvalsByInstance[instanceName] ?? []).filter((approval) => approval.status === "pending");

    switch (page) {
        case "instances":
            return [
                makeBox(state, page, instanceName, {
                    detailLines: [
                        formatField("Daemon", snapshot?.daemonState ?? "unknown"),
                        formatField("Connect", snapshot?.connectionState ?? "unknown"),
                        formatField("Ready", snapshot?.ready === true ? "yes" : "no"),
                        formatField("Status", snapshot?.status ?? "unknown")
                    ],
                    id: "runtime",
                    status: runtimeStatus(snapshot),
                    summaryLines: [
                        compactSummary(
                            ["daemon", snapshot?.daemonState ?? "unknown"],
                            ["rpc", snapshot?.connectionState ?? "unknown"],
                            ["ready", snapshot?.ready === true ? "yes" : "no"],
                            ["seq", String(state.lastSeqByInstance[instanceName] ?? snapshot?.lastSeq ?? 0)]
                        )
                    ],
                    title: "Runtime"
                }),
                makeBox(state, page, instanceName, {
                    detailLines: [
                        formatField("Provider", instance?.provider ?? "unknown"),
                        formatField("Workspace", instance?.defaultWorkspace ?? "unavailable"),
                        formatField("Last Seq", String(state.lastSeqByInstance[instanceName] ?? snapshot?.lastSeq ?? 0))
                    ],
                    id: "worker",
                    status: snapshot?.daemonState === "running" ? "running" : snapshot?.daemonState === "stopped" ? "disabled" : "warning",
                    summaryLines: [
                        compactSummary(
                            ["provider", instance?.provider ?? "unknown"],
                            ["workspace", shortenPath(instance?.defaultWorkspace ?? "unavailable")],
                            ["seq", String(state.lastSeqByInstance[instanceName] ?? snapshot?.lastSeq ?? 0)]
                        )
                    ],
                    title: "Worker"
                }),
                makeBox(state, page, instanceName, {
                    detailLines: [
                        formatField("Enabled", instance?.mcpEnabled === true ? "yes" : "no"),
                        formatField("Path", instance?.mcpPath ?? "unavailable")
                    ],
                    id: "mcp",
                    status: instance?.mcpEnabled === true ? "ready" : "disabled",
                    summaryLines: [
                        compactSummary(
                            ["enabled", instance?.mcpEnabled === true ? "yes" : "no"],
                            ["path", shortenPath(instance?.mcpPath ?? "unavailable")]
                        )
                    ],
                    title: "MCP"
                }),
                makeBox(state, page, instanceName, {
                    detailLines: [
                        formatField("Preview", buildEndpointPreview(state, instanceName)),
                        formatField("Public URL", config?.publicBaseUrl ?? "unavailable"),
                        "Runtime readiness: not available in current control API"
                    ],
                    id: "public-endpoint",
                    status: "warning",
                    summaryLines: [
                        compactSummary(
                            ["endpoint", endpointAvailabilityLabel(config?.publicBaseUrl)],
                            ["auth", config?.authMode ?? "unavailable"],
                            ["baseUrl", config?.publicBaseUrl ?? "-"]
                        ),
                        "reason=no-runtime-api"
                    ],
                    title: "Public Endpoint"
                }),
                makeBox(state, page, instanceName, {
                    detailLines: approvals.length === 0 ? ["none"] : approvals.slice(0, 6).map(renderApprovalLine),
                    id: "approvals",
                    status: approvals.length > 0 ? "pending" : "normal",
                    summaryLines: [
                        compactSummary(
                            ["pending", String(approvals.length)],
                            ["tool", approvals[0]?.toolName ?? "-"],
                            ["risk", approvals[0] === undefined ? "-" : "high"]
                        )
                    ],
                    title: "Approvals"
                }),
                makeBox(state, page, instanceName, {
                    detailLines: toolCalls.length === 0 ? ["none"] : toolCalls.slice(0, 6).map(renderToolCallLine),
                    id: "recent-audit",
                    status: "normal",
                    summaryLines: [
                        compactSummary(
                            ["records", String(toolCalls.length)],
                            ["last", toolCalls[0]?.status ?? "-"],
                            ["tool", toolCalls[0]?.toolName ?? "-"]
                        )
                    ],
                    title: "Recent Audit"
                }),
                makeBox(state, page, instanceName, {
                    detailLines: logs.length === 0 ? ["none"] : logs.slice(-8).map(renderLogLine),
                    id: "recent-logs",
                    status: "normal",
                    summaryLines: [
                        compactSummary(
                            ["entries", String(logs.length)],
                            ["last", logs.at(-1)?.tail ?? logs.at(-1)?.message ?? "-"]
                        )
                    ],
                    title: "Recent Logs"
                }),
                makeBox(state, page, instanceName, {
                    detailLines: [
                        formatField("Provider", instance?.provider ?? "unknown"),
                        formatField("Workspace", instance?.defaultWorkspace ?? "unavailable"),
                        formatField("MCP Path", instance?.mcpPath ?? "unavailable")
                    ],
                    id: "config-summary",
                    status: "normal",
                    summaryLines: [
                        compactSummary(
                            ["provider", instance?.provider ?? "unknown"],
                            ["workspace", shortenPath(instance?.defaultWorkspace ?? "unavailable")],
                            ["mcp", instance?.mcpEnabled === true ? "enabled" : "disabled"]
                        )
                    ],
                    title: "Config Summary"
                }),
                makeBox(state, page, instanceName, {
                    detailLines: ["Shell execution is disabled in Prompt 3 read-only mode."],
                    disabled: true,
                    id: "shell-preview",
                    status: "disabled",
                    summaryLines: [compactSummary(["attach", "disabled"], ["mode", "readonly"])],
                    title: "Shell Preview"
                })
            ];
        case "config":
            return [
                makeBox(state, page, instanceName, {
                    detailLines: [`provider ${instance?.provider ?? "unknown"}`],
                    id: "provider",
                    summaryLines: [compactSummary(["provider", instance?.provider ?? "unknown"])],
                    title: "Provider"
                }),
                makeBox(state, page, instanceName, {
                    detailLines: [`workspace ${instance?.defaultWorkspace ?? "unavailable"}`],
                    id: "workspace",
                    summaryLines: [compactSummary(["workspace", shortenPath(instance?.defaultWorkspace ?? "unavailable")])],
                    title: "Workspace"
                }),
                makeBox(state, page, instanceName, {
                    detailLines: [`enabled ${instance?.mcpEnabled === true ? "true" : "false"}`, `path ${instance?.mcpPath ?? "unavailable"}`],
                    id: "mcp-config",
                    status: instance?.mcpEnabled === true ? "ready" : "disabled",
                    summaryLines: [
                        compactSummary(
                            ["enabled", instance?.mcpEnabled === true ? "true" : "false"],
                            ["path", shortenPath(instance?.mcpPath ?? "unavailable")]
                        )
                    ],
                    title: "MCP"
                }),
                makeBox(state, page, instanceName, {
                    detailLines: [`lastErrorCode ${snapshot?.lastErrorCode ?? "none"}`, `connectionState ${snapshot?.connectionState ?? "unknown"}`],
                    id: "security",
                    status: snapshot?.lastErrorCode === undefined ? "normal" : "warning",
                    summaryLines: [
                        compactSummary(
                            ["lastError", snapshot?.lastErrorCode ?? "none"],
                            ["connection", snapshot?.connectionState ?? "unknown"]
                        )
                    ],
                    title: "Security"
                }),
                makeBox(state, page, instanceName, {
                    detailLines: approvals.length === 0 ? ["pending approvals none"] : approvals.slice(0, 6).map(renderApprovalLine),
                    id: "approval-policy",
                    status: approvals.length > 0 ? "pending" : "normal",
                    summaryLines: [compactSummary(["pending", String(approvals.length)], ["mode", "readonly"])],
                    title: "Approval Policy"
                }),
                makeBox(state, page, instanceName, {
                    detailLines: ["source instance.readLogs + log.appended", `cached ${logs.length}`],
                    id: "logs-policy",
                    summaryLines: [compactSummary(["source", "instance.readLogs"], ["cached", String(logs.length)])],
                    title: "Logs Policy"
                })
            ];
        case "connector":
            return [
                makeBox(state, page, instanceName, {
                    detailLines: [
                        `mcp enabled ${instance?.mcpEnabled === true ? "true" : "false"}`,
                        `mcp path ${instance?.mcpPath ?? "unavailable"}`,
                        "Runtime readiness: not available in current control API"
                    ],
                    id: "mcp-runtime-config",
                    status: instance?.mcpEnabled === true ? "warning" : "disabled",
                    summaryLines: [
                        compactSummary(
                            ["enabled", instance?.mcpEnabled === true ? "true" : "false"],
                            ["path", shortenPath(instance?.mcpPath ?? "unavailable")]
                        ),
                        "reason=no-runtime-api"
                    ],
                    title: "MCP Runtime Config"
                }),
                makeBox(state, page, instanceName, {
                    detailLines: [buildEndpointPreview(state, instanceName), "Runtime readiness: not available in current control API"],
                    id: "endpoint-preview",
                    status: "warning",
                    summaryLines: [compactSummary(["endpoint", buildEndpointPreview(state, instanceName)]), "reason=preview-only"],
                    title: "Endpoint Preview"
                }),
                makeBox(state, page, instanceName, {
                    detailLines: [`auth.mode ${config?.authMode ?? "unavailable"}`, `publicBaseUrl ${config?.publicBaseUrl ?? "unavailable"}`],
                    id: "auth-config",
                    summaryLines: [compactSummary(["auth", config?.authMode ?? "unavailable"], ["baseUrl", config?.publicBaseUrl ?? "-"])],
                    title: "Auth Config"
                }),
                makeBox(state, page, instanceName, {
                    detailLines: [
                        config?.publicBaseUrl === undefined ? "publicBaseUrl missing" : `publicBaseUrl ${config.publicBaseUrl}`,
                        "Runtime readiness: not available in current control API"
                    ],
                    id: "public-availability-reason",
                    status: "warning",
                    summaryLines: [
                        compactSummary(["endpoint", endpointAvailabilityLabel(config?.publicBaseUrl)]),
                        config?.publicBaseUrl === undefined ? "reason=missing-publicBaseUrl" : "reason=no-runtime-api"
                    ],
                    title: "Public Availability Reason"
                })
            ];
        case "audit":
            return (toolCalls.length === 0 ? [undefined] : toolCalls).map((record, index) =>
                makeBox(state, page, instanceName, {
                    detailLines:
                        record === undefined
                            ? ["No tool call history from instance.readToolCalls or stream events."]
                            : [
                                  `callId ${record.callId}`,
                                  `tool ${record.toolName}`,
                                  `status ${record.status}`,
                                  `startedAt ${record.startedAt}`,
                                  `completedAt ${record.completedAt ?? "-"}`,
                                  `source ${record.source}`,
                                  `input ${record.inputSummary || "-"}`
                              ],
                    id: record === undefined ? "audit-empty" : `audit-${record.callId}`,
                    status: record === undefined ? "normal" : toolCallStatus(record),
                    summaryLines: [
                        record === undefined
                            ? compactSummary(["records", "0"], ["last", "-"], ["tool", "-"])
                            : compactSummary(["status", record.status], ["tool", record.toolName], ["source", record.source])
                    ],
                    title: record === undefined ? "Audit" : `Audit ${index + 1}`
                })
            );
        case "logs": {
            const filtered = applySearch(logs.map(renderLogLine), state.ui.searchQueries[page] ?? "");
            return [
                makeBox(state, page, instanceName, {
                    detailLines: filtered.length === 0 ? ["No logs loaded yet."] : filtered,
                    id: "logs",
                    status: "normal",
                    summaryLines: [compactSummary(["source", "instance.readLogs+log.appended"], ["entries", String(logs.length)])],
                    title: "Logs"
                }),
                makeBox(state, page, instanceName, {
                    detailLines: [
                        "Logs page only reads instance.readLogs.",
                        "Live updates only append from log.appended stream events.",
                        "worker.log is never read directly."
                    ],
                    id: "logs-source",
                    status: "normal",
                    summaryLines: [compactSummary(["source", "instance.readLogs"], ["stream", "log.appended"])],
                    title: "Source"
                })
            ];
        }
    }
}

function makeBox(
    state: TuiAppState,
    page: PageId,
    instance: string | undefined,
    input: {
        detailLines: string[];
        disabled?: boolean;
        id: string;
        status?: ExpandableBoxStatus;
        summaryLines: string[];
        title: string;
    }
): BoxModel {
    const expandedKey = `${page}:${instance}:${input.id}`;
    const summaryLines = normalizeCollapsedLines(input.summaryLines);

    return {
        collapsedLines: summaryLines,
        disabled: input.disabled,
        expanded: state.ui.expandedBoxes[expandedKey] === true,
        expandedLines: input.detailLines.map((line) => ({ text: line })),
        focused: state.ui.mainFocusId === input.id && (state.interaction.focusScope === "mainBoxes" || state.interaction.focusScope === "boxDetail"),
        id: input.id,
        status: input.status ?? "normal",
        title: input.title
    };
}

function normalizeCollapsedLines(lines: string[]): [BoxLine] | [BoxLine, BoxLine] {
    const normalized = lines.slice(0, 2).map((line, index) => ({
        text: line,
        tone: collapsedToneFor(line, index)
    }));

    if (normalized.length <= 1) {
        return [normalized[0] ?? { text: "", tone: "muted" }];
    }

    return [normalized[0], normalized[1]];
}

function truncateLine(text: string, width: number): string {
    if (text.length <= width) {
        return text;
    }

    if (width <= 1) {
        return "…";
    }

    return `${text.slice(0, width - 1)}…`;
}

function formatField(label: string, value: string): string {
    return `${label.padEnd(14, " ")} ${value}`;
}

function shortenPath(value: string): string {
    if (value.length <= 28) {
        return value;
    }

    return `...${value.slice(-(28 - 3))}`;
}

function compactSummary(...entries: Array<[string, string]>): string {
    return entries.map(([key, value]) => `${key}=${value}`).join("  ");
}

function collapsedToneFor(line: string, index: number): BoxLine["tone"] {
    if (index === 0) {
        return "normal";
    }

    if (line.startsWith("reason=") || line.startsWith("lastError=")) {
        return "warning";
    }

    return "muted";
}

function endpointAvailabilityLabel(publicBaseUrl: string | undefined): string {
    return publicBaseUrl === undefined ? "unavailable" : "configured";
}

function pageTitle(page: PageId): string {
    return pageEntries.find((entry) => entry.id === page)?.label ?? page;
}

function readConfigInstance(state: TuiAppState, instanceName: string): {
    authMode?: string;
    publicBaseUrl?: string;
} | undefined {
    const instances = state.configView?.instances;
    const mcp = asRecord(state.configView?.mcp);
    const auth = asRecord(mcp?.auth);

    if (!Array.isArray(instances)) {
        return {
            authMode: typeof auth?.mode === "string" ? auth.mode : undefined,
            publicBaseUrl: typeof mcp?.publicBaseUrl === "string" ? mcp.publicBaseUrl : undefined
        };
    }

    const configEntry = instances.find(
        (entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry) && (entry as Record<string, JsonValue>).name === instanceName
    ) as Record<string, JsonValue> | undefined;

    return {
        authMode: typeof auth?.mode === "string" ? auth.mode : undefined,
        publicBaseUrl: typeof mcp?.publicBaseUrl === "string" ? mcp.publicBaseUrl : undefined,
        ...(configEntry === undefined ? {} : {})
    };
}

function buildEndpointPreview(state: TuiAppState, instanceName: string): string {
    const mcp = asRecord(state.configView?.mcp);
    if (mcp?.enabled !== true) {
        return "mcp disabled";
    }

    const host = typeof mcp.listenHost === "string" ? mcp.listenHost : "127.0.0.1";
    const port = typeof mcp.listenPort === "number" ? String(mcp.listenPort) : "unavailable";
    return `http://${host}:${port}/${instanceName}/mcp`;
}

function runtimeStatus(snapshot: TuiAppState["snapshotsByInstance"][string] | undefined): ExpandableBoxStatus {
    if (snapshot?.status === "ready") {
        return "ready";
    }
    if (snapshot?.daemonState === "running") {
        return "running";
    }
    if (snapshot?.daemonState === "stopped") {
        return "disabled";
    }
    if (snapshot?.daemonState === "failed" || snapshot?.status === "failed") {
        return "failed";
    }
    return "warning";
}

function toolCallStatus(record: ToolCallRecord): ExpandableBoxStatus {
    switch (record.status) {
        case "completed":
            return "ready";
        case "running":
            return "running";
        case "pendingApproval":
            return "pending";
        case "failed":
        case "denied":
        case "expired":
            return "failed";
    }
}

function renderApprovalLine(approval: ApprovalRequest): string {
    return `${approval.toolName} ${approval.approvalId} ${approval.riskLevel}`;
}

function renderToolCallLine(record: ToolCallRecord): string {
    return `${record.toolName} ${record.status} ${record.callId}`;
}

function renderLogLine(entry: TuiLogEntry): string {
    return `${entry.stream} #${entry.seq} ${entry.message ?? entry.tail ?? entry.preview ?? ""}`;
}

function applySearch(lines: string[], query: string): string[] {
    if (query.length === 0) {
        return lines;
    }

    return lines.filter((line) => line.toLowerCase().includes(query.toLowerCase()));
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
