import type { ApprovalRequest, JsonValue, ToolCallRecord } from "@portable-devshell/shared";

import type { BoxLine, BoxModel } from "../component/TuiComponentExpandableBox.js";
import type { TuiExpandableBoxStatus, TuiPageId } from "../TuiUiModel.js";
import type { TuiAppState, TuiLogEntry, TuiInstanceListEntry } from "../../state/TuiStoreTypes.js";

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
    page: TuiPageId,
    instance: string | undefined,
    input: {
        detailLines: Array<string | { disabled?: boolean; id: string; text: string; tone?: BoxLine["tone"] }>;
        disabled?: boolean;
        expandedKey?: string;
        id: string;
        severity?: BoxLine["tone"];
        status?: TuiExpandableBoxStatus;
        summaryLines: string[];
        title: string;
    }
): BoxModel {
    const expandedKey = input.expandedKey ?? `${page}:${instance}:${input.id}`;
    const summaryLines = normalizeCollapsedLines(input.summaryLines);

    const selectedDetailLineId = state.interaction.selectedDetailLineIds[expandedKey];
    const expandedLines = normalizeExpandedLines(input.id, input.detailLines).map((line) =>
        state.interaction.editor?.editing === true && line.id === selectedDetailLineId
            ? { ...line, text: insertCursor(line.text, state.interaction.editor.cursor ?? 0, state.interaction.redrawNonce % 2 === 0) }
            : line
    );

    return {
        collapsedLines: summaryLines,
        disabled: input.disabled,
        expanded: state.ui.expandedBoxes[expandedKey] === true,
        expandedKey,
        expandedLines,
        focused:
            state.ui.mainFocusId === input.id &&
            (state.interaction.focusScope === "mainBoxes" ||
                state.interaction.focusScope === "boxDetail" ||
                state.interaction.focusScope === "form" ||
                state.interaction.focusScope === "wizard"),
        id: input.id,
        severity: input.severity,
        selectedDetailLineId: expandedLines.some((line) => line.id === selectedDetailLineId) ? selectedDetailLineId : expandedLines[0]?.id,
        status: input.status ?? "normal",
        title: input.title
    };
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

export function runtimeStatus(snapshot: TuiAppState["snapshotsByInstance"][string] | undefined): TuiExpandableBoxStatus {
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

export function toolCallStatus(record: ToolCallRecord): TuiExpandableBoxStatus {
    switch (record.status) {
        case "completed":
            return "ready";
        case "running":
            return "running";
        case "queued":
        case "pendingApproval":
            return "pending";
        case "cancelled":
            return "warning";
        case "failed":
        case "denied":
        case "expired":
        case "queueTimeout":
            return "failed";
    }
}

export function renderLogLine(entry: TuiLogEntry): string {
    const context = [
        entry.toolName === undefined ? undefined : `tool=${entry.toolName}`,
        entry.callId === undefined ? undefined : `call=${entry.callId}`,
        entry.requestId === undefined ? undefined : `request=${entry.requestId}`,
        entry.ctxId === undefined ? undefined : `session=${entry.ctxId}`,
        entry.source === undefined ? undefined : `source=${entry.source}`
    ].filter(Boolean).join(" ");
    return `${entry.at ?? entry.receivedAt} ${entry.stream} #${entry.seq}${context.length === 0 ? "" : ` ${context}`} ${entry.message ?? entry.tail ?? entry.preview ?? ""}`;
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
    lines: Array<string | { disabled?: boolean; id: string; text: string; tone?: BoxLine["tone"] }>
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
            ...(typeof line === "string" || line.disabled !== true ? {} : { disabled: true }),
            ...(typeof line === "string" || line.tone === undefined ? {} : { tone: line.tone })
        };
    });
}

function stableDetailLineId(text: string): string {
    const field = text.trim().split(/\s{2,}|\s/)[0] ?? "detail";
    return field.replace(/[^a-zA-Z0-9_.:-]/g, "-") || "detail";
}

function insertCursor(text: string, offset: number, visible: boolean): string {
    const start = text.lastIndexOf("[ ");
    const end = text.lastIndexOf(" ]");
    if (start === -1 || end <= start) {
        return text;
    }
    const valueStart = start + 2;
    const value = text.slice(valueStart, end);
    const cursor = Math.min(Math.max(offset, 0), value.length);
    return `${text.slice(0, valueStart)}${value.slice(0, cursor)}${visible ? "█" : " "}${value.slice(cursor)}${text.slice(end)}`;
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
