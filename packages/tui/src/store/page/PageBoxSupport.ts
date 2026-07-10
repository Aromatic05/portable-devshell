import type { ApprovalRequest, JsonValue, ToolCallRecord } from "@portable-devshell/shared";

import type { BoxLine, BoxModel } from "../../component/ExpandableBox.js";
import type { ExpandableBoxStatus, PageId } from "../../model/TuiUiTypes.js";
import type { TuiAppState, TuiLogEntry, TuiInstanceListEntry } from "../TuiReducers.js";

export interface SelectedInstancePageContext {
    approvals: ApprovalRequest[];
    config: {
        authMode?: string;
        publicBaseUrl?: string;
    } | undefined;
    instance: TuiInstanceListEntry | undefined;
    logs: TuiLogEntry[];
    snapshot: TuiAppState["snapshotsByInstance"][string] | undefined;
    toolCalls: ToolCallRecord[];
}

export function buildSelectedInstancePageContext(state: TuiAppState, instanceName: string): SelectedInstancePageContext {
    return {
        approvals: (state.approvalsByInstance[instanceName] ?? []).filter((approval) => approval.status === "pending"),
        config: readConfigInstance(state, instanceName),
        instance: state.instances.find((entry) => entry.name === instanceName),
        logs: state.logsByInstance[instanceName] ?? [],
        snapshot: state.snapshotsByInstance[instanceName],
        toolCalls: state.toolCallsByInstance[instanceName] ?? []
    };
}

export function makeBox(
    state: TuiAppState,
    page: PageId,
    instance: string | undefined,
    input: {
        detailLines: Array<string | { id: string; text: string; tone?: BoxLine["tone"] }>;
        disabled?: boolean;
        id: string;
        status?: ExpandableBoxStatus;
        summaryLines: string[];
        title: string;
    }
): BoxModel {
    const expandedKey = `${page}:${instance}:${input.id}`;
    const summaryLines = normalizeCollapsedLines(input.summaryLines);

    const expandedLines = normalizeExpandedLines(input.id, input.detailLines);
    const selectedDetailLineId = state.interaction.selectedDetailLineIds[expandedKey];

    return {
        collapsedLines: summaryLines,
        disabled: input.disabled,
        expanded: state.ui.expandedBoxes[expandedKey] === true,
        expandedLines,
        focused: state.ui.mainFocusId === input.id && (state.interaction.focusScope === "mainBoxes" || state.interaction.focusScope === "boxDetail"),
        id: input.id,
        selectedDetailLineId: expandedLines.some((line) => line.id === selectedDetailLineId) ? selectedDetailLineId : expandedLines[0]?.id,
        status: input.status ?? "normal",
        title: input.title
    };
}

export function buildCommandBoxes(state: TuiAppState, page: PageId, instance: string | undefined): BoxModel[] {
    if (instance === undefined) {
        return [];
    }

    const command = state.commandRecords.find(
        (record) => record.targetInstance === instance && record.title === `Start Worker: ${instance}`
    );

    if (command === undefined) {
        return [];
    }

    const relay = state.relayByCommand[command.commandId];
    const output = relay?.output.flatMap((chunk) => chunk.split(/\r?\n/)).filter((line) => line.length > 0) ?? [];
    const status = command.status === "succeeded" ? "ready" : command.status === "failed" ? "failed" : "running";

    return [
        makeBox(state, page, instance, {
            detailLines: [
                formatField("Workspace", relay?.workspace ?? "unavailable"),
                formatField("Provider", relay?.provider ?? "unknown"),
                formatField("Status", command.status),
                ...(command.error === undefined ? [] : [formatField("Error", `${command.error.code}: ${command.error.message}`)]),
                "Relay output:",
                ...(output.length === 0 ? ["No relay output received."] : output)
            ],
            id: `start-${command.commandId}`,
            status,
            summaryLines: [
                compactSummary(["status", command.status], ["workspace", shortenPath(relay?.workspace ?? "unavailable")]),
                command.error === undefined ? "relay=control RPC" : `lastError=${command.error.code}`
            ],
            title: `Start Worker: ${instance}`
        })
    ];
}

export function formatField(label: string, value: string): string {
    return `${label.padEnd(14, " ")} ${value}`;
}

export function shortenPath(value: string): string {
    if (value.length <= 28) {
        return value;
    }

    return `...${value.slice(-(28 - 3))}`;
}

export function compactSummary(...entries: Array<[string, string]>): string {
    return entries.map(([key, value]) => `${key}=${value}`).join("  ");
}

export function endpointAvailabilityLabel(publicBaseUrl: string | undefined): string {
    return publicBaseUrl === undefined ? "unavailable" : "configured";
}

export function readConfigInstance(state: TuiAppState, instanceName: string): {
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

export function buildEndpointPreview(state: TuiAppState, instanceName: string): string {
    const mcp = asRecord(state.configView?.mcp);
    if (mcp?.enabled !== true) {
        return "mcp disabled";
    }

    const host = typeof mcp.listenHost === "string" ? mcp.listenHost : "127.0.0.1";
    const port = typeof mcp.listenPort === "number" ? String(mcp.listenPort) : "unavailable";
    return `http://${host}:${port}/${instanceName}/mcp`;
}

export function runtimeStatus(snapshot: TuiAppState["snapshotsByInstance"][string] | undefined): ExpandableBoxStatus {
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

export function toolCallStatus(record: ToolCallRecord): ExpandableBoxStatus {
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

export function renderApprovalLine(approval: ApprovalRequest): string {
    return `${approval.toolName} ${approval.approvalId} ${approval.riskLevel}`;
}

export function renderToolCallLine(record: ToolCallRecord): string {
    return `${record.toolName} ${record.status} ${record.callId}`;
}

export function renderLogLine(entry: TuiLogEntry): string {
    return `${entry.stream} #${entry.seq} ${entry.message ?? entry.tail ?? entry.preview ?? ""}`;
}

export function applySearch(lines: string[], query: string): string[] {
    if (query.length === 0) {
        return lines;
    }

    return lines.filter((line) => line.toLowerCase().includes(query.toLowerCase()));
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

function normalizeExpandedLines(
    boxId: string,
    lines: Array<string | { id: string; text: string; tone?: BoxLine["tone"] }>
): BoxLine[] {
    const occurrences = new Map<string, number>();

    return lines.map((line) => {
        const text = typeof line === "string" ? line : line.text;
        const requestedId = typeof line === "string" ? stableDetailLineId(text) : line.id;
        const occurrence = occurrences.get(requestedId) ?? 0;
        occurrences.set(requestedId, occurrence + 1);

        return {
            id: occurrence === 0 ? `${boxId}:${requestedId}` : `${boxId}:${requestedId}:${occurrence + 1}`,
            text,
            ...(typeof line === "string" || line.tone === undefined ? {} : { tone: line.tone })
        };
    });
}

function stableDetailLineId(text: string): string {
    const field = text.trim().split(/\s{2,}|\s/)[0] ?? "detail";
    return field.replace(/[^a-zA-Z0-9_.:-]/g, "-") || "detail";
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

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
