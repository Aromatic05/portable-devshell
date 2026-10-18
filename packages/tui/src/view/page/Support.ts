import type {
    InstanceListEntry,
    InstanceSnapshot,
    ApprovalRequest,
    ToolCallRecord,
} from "@portable-devshell/shared";

import type { BoxLine, BoxModel } from "../component/content/Box.js";
import type { TuiDomainReader } from "../../app/control/Reader.js";
import type { TuiRoute } from "../../state/route/Model.js";
import { currentTuiRouteItemKey } from "../../state/route/State.js";
import { resolveSelectedDetailLineId } from "../../interaction/selection/Detail.js";
import type { TuiExpandableBoxStatus, TuiPageId } from "../../state/Ui.js";
import { type TuiAppState, type TuiLogEntry } from "../../state/store/Model.js";

export interface SelectedInstancePageContext {
    approvals: ApprovalRequest[];
    config:
        | {
              authMode?: string;
              publicBaseUrl?: string;
          }
        | undefined;
    instance: InstanceListEntry | undefined;
    logs: TuiLogEntry[];
    snapshot: InstanceSnapshot | undefined;
    toolCalls: ToolCallRecord[];
}

export function buildSelectedInstancePageContext(
    reader: TuiDomainReader,
    instanceName: string,
): SelectedInstancePageContext {
    const runtime = reader.runtime(instanceName);
    return {
        approvals: (reader.approval(instanceName).approvals ?? []).filter(
            (approval) => approval.status === "pending",
        ),
        config: readConfigInstance(reader, instanceName),
        instance: reader.instances.instances.find(
            (entry) => entry.name === instanceName,
        ),
        logs: runtime.logs,
        snapshot: runtime.snapshot,
        toolCalls: reader.toolCalls.instances[instanceName]?.calls ?? [],
    };
}

export function makeBox(
    state: TuiAppState,
    page: TuiPageId,
    instance: string | undefined,
    input: {
        detailLines: Array<
            | string
            | {
                  disabled?: boolean;
                  editable?: boolean;
                  editableValue?: BoxLine["editableValue"];
                  id: string;
                  text: string;
                  tone?: BoxLine["tone"];
              }
        >;
        disabled?: boolean;
        editable?: boolean;
        expandable?: boolean;
        expandedKey?: string;
        id: string;
        primaryRoute?: TuiRoute;
        searchText?: string;
        severity?: BoxLine["tone"];
        status?: TuiExpandableBoxStatus;
        summaryLines: string[];
        title: string;
    },
): BoxModel {
    const expandedKey =
        input.expandedKey ?? currentTuiRouteItemKey(state, input.id);
    const expandable = input.expandable ?? input.detailLines.length > 0;
    const summaryLines = normalizeCollapsedLines(input.summaryLines);

    const expanded = expandable && state.ui.expandedBoxes[expandedKey] === true;
    const selectedDetailLineId =
        state.interaction.selectedDetailLineIds[expandedKey];
    const expandedLines = expanded
        ? normalizeExpandedLines(input.id, input.detailLines).map((line) =>
              state.interaction.editor?.editing === true &&
              line.id === selectedDetailLineId &&
              line.editableValue !== undefined
                  ? {
                        ...line,
                        cursor:
                            state.interaction.editor.cursor ??
                            line.editableValue.value.length,
                        cursorVisible: state.interaction.redrawNonce % 2 === 0,
                        editing: true,
                    }
                  : line,
          )
        : [];

    return {
        collapsedLines: summaryLines,
        disabled: input.disabled,
        editable: input.editable,
        enterable: input.primaryRoute !== undefined && input.disabled !== true,
        expandable,
        expanded,
        expandedKey,
        expandedLines,
        focused:
            state.ui.mainFocusId === input.id &&
            (state.interaction.focusScope === "mainBoxes" ||
                state.interaction.focusScope === "boxDetail" ||
                state.interaction.focusScope === "form" ||
                state.interaction.focusScope === "wizard" ||
                state.interaction.focusScope === "contextMessage"),
        id: input.id,
        primaryAction:
            input.primaryRoute === undefined
                ? undefined
                : { kind: "navigate", route: input.primaryRoute },
        searchText: input.searchText,
        severity: input.severity,
        selectedDetailLineId: resolveSelectedDetailLineId(
            expandedLines.map((line) => line.id),
            selectedDetailLineId,
        ),
        status: input.status ?? "normal",
        title: input.title,
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

export function readConfigInstance(
    reader: TuiDomainReader,
    instanceName: string,
):
    | {
          authMode?: string;
          publicBaseUrl?: string;
      }
    | undefined {
    const configView = reader.config.view;
    const configEntry = configView?.instances.find(
        (entry) => entry.name === instanceName,
    );

    return {
        authMode: configEntry?.mcp.auth.mode,
        publicBaseUrl: configView?.mcp.publicBaseUrl,
    };
}

export function runtimeStatus(
    snapshot: InstanceSnapshot | undefined,
): TuiExpandableBoxStatus {
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
            return "pending";
        case "cancelled":
            return "warning";
        case "failed":
        case "denied":
        case "queueTimeout":
            return "failed";
    }
}

export function renderLogLine(entry: TuiLogEntry): string {
    const context = [
        entry.toolName === undefined ? undefined : `tool=${entry.toolName}`,
        entry.callId === undefined ? undefined : `call=${entry.callId}`,
        entry.requestId === undefined
            ? undefined
            : `request=${entry.requestId}`,
        entry.ctxId === undefined ? undefined : `session=${entry.ctxId}`,
        entry.source === undefined ? undefined : `source=${entry.source}`,
    ]
        .filter(Boolean)
        .join(" ");
    return `${entry.at} ${entry.stream} #${entry.seq}${context.length === 0 ? "" : ` ${context}`} ${entry.message}`;
}

function normalizeCollapsedLines(
    lines: string[],
): [BoxLine] | [BoxLine, BoxLine] {
    const normalized = lines.slice(0, 2).map((line, index) => ({
        text: line,
        tone: collapsedToneFor(line, index),
    }));

    if (normalized.length <= 1) {
        return [normalized[0] ?? { text: "", tone: "muted" }];
    }

    return [normalized[0], normalized[1]];
}

function normalizeExpandedLines(
    boxId: string,
    lines: Array<
        | string
        | {
              disabled?: boolean;
              editable?: boolean;
              editableValue?: BoxLine["editableValue"];
              id: string;
              text: string;
              tone?: BoxLine["tone"];
          }
    >,
): BoxLine[] {
    const occurrences = new Map<string, number>();

    return lines.map((line) => {
        const text = typeof line === "string" ? line : line.text;
        const requestedId =
            typeof line === "string" ? stableDetailLineId(text) : line.id;
        const occurrence = occurrences.get(requestedId) ?? 0;
        occurrences.set(requestedId, occurrence + 1);

        return {
            id:
                occurrence === 0
                    ? `${boxId}:${requestedId}`
                    : `${boxId}:${requestedId}:${occurrence + 1}`,
            text,
            ...(typeof line === "string" || line.disabled !== true
                ? {}
                : { disabled: true }),
            ...(typeof line === "string" || line.editable !== true
                ? {}
                : { editable: true }),
            ...(typeof line === "string" || line.editableValue === undefined
                ? {}
                : { editableValue: line.editableValue }),
            ...(typeof line === "string" || line.tone === undefined
                ? {}
                : { tone: line.tone }),
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
