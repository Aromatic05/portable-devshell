import { TuiFocusItem } from "../../state/focus/TuiFocusItem.js";
import { Box, Text } from "ink";
import type { ApprovalRequest, ToolCallRecord } from "@portable-devshell/shared";

import { renderExpandableBoxLines } from "../component/TuiComponentExpandableBox.js";
import { TuiComponentErrorBanner } from "../component/TuiComponentErrorBanner.js";
import { TuiFocusGraph, type TuiFocusNode } from "../../state/focus/TuiFocusGraph.js";
import type { TuiPageId } from "../../state/TuiUiState.js";
import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import { selectMainBoxFlowMetrics, selectMainScreenModel } from "../model/TuiViewProjection.js";

export const orderedPages: TuiPageId[] = ["instances", "config", "connector", "oauth", "audit", "logs", "todo", "help"];

export interface TuiScreenRouterProps {
    boxInnerWidth: number;
    state: TuiAppState;
    viewportRows: number;
}

export function TuiScreenRouter(props: TuiScreenRouterProps) {
    const textDetail = props.state.interaction.textDetail;
    if (textDetail.open) {
        const width = Math.max(20, props.boxInnerWidth);
        const lines = wrapText(textDetail.body, width);
        const viewport = Math.max(1, props.viewportRows - 2);
        const offset = clamp(textDetail.scrollOffset, 0, Math.max(0, lines.length - viewport));
        return (
            <Box flexDirection="column">
                <Text bold>{textDetail.title}</Text>
                {lines.slice(offset, offset + viewport).map((line, index) => <Text color={detailLineColor(line)} key={`${offset + index}:${line}`}>{line}</Text>)}
                <Text dimColor>{`line ${Math.min(offset + 1, Math.max(lines.length, 1))}-${Math.min(offset + viewport, lines.length)} / ${lines.length} · Esc/Enter back`}</Text>
            </Box>
        );
    }
    const auditPage = props.state.interaction.auditPage;
    if (props.state.ui.selectedPage === "audit" && auditPage.mode !== "list") {
        const approval = (props.state.approvalsByInstance[props.state.ui.selectedInstance ?? ""] ?? []).find(
            (candidate) => candidate.approvalId === auditPage.approvalId
        );
        const toolCall = approval === undefined
            ? undefined
            : (props.state.toolCallsByInstance[approval.instance] ?? []).find((candidate) => candidate.callId === approval.callId);
        const relatedCalls = approval === undefined
            ? []
            : (props.state.toolCallsByInstance[approval.instance] ?? [])
                .filter((candidate) => candidate.callId !== approval.callId)
                .sort((left, right) => Math.abs(Date.parse(left.startedAt) - Date.parse(approval.createdAt)) - Math.abs(Date.parse(right.startedAt) - Date.parse(approval.createdAt)))
                .slice(0, 3);
        return <ApprovalDetail approval={approval} mode={auditPage.mode} relatedCalls={relatedCalls} selectedAction={auditPage.selectedAction} toolCall={toolCall} />;
    }
    const model = selectMainScreenModel(props.state);
    const flow = selectMainBoxFlowMetrics(props.state, props.boxInnerWidth);
    const scrollOffset = props.state.ui.scrollOffsets[flow.scrollKey] ?? 0;
    const boxViewportRows = Math.max(0, props.viewportRows - 1 - (model.statusLine === undefined ? 0 : 1) - (model.emptyState === undefined ? 0 : 1));
    const renderedLines = model.boxes.flatMap((box) => renderExpandableBoxLines(box, props.boxInnerWidth));
    const clampedOffset = clamp(scrollOffset, 0, Math.max(0, renderedLines.length - boxViewportRows));
    const visibleLines = boxViewportRows > 0 ? renderedLines.slice(clampedOffset, clampedOffset + boxViewportRows) : [];

    return (
        <Box flexDirection="column">
            <Text bold>{model.pageTitle}</Text>
            {model.errorLines === undefined ? undefined : <TuiComponentErrorBanner lines={model.errorLines} />}
            {model.emptyState !== undefined ? <Text color="yellow">{model.emptyState}</Text> : undefined}
            {model.emptyState === undefined
                ? visibleLines.map((line) => (
                      <Text backgroundColor={line.backgroundColor} color={line.color} dimColor={line.dimColor} key={line.key}>
                          {line.text}
                      </Text>
                  ))
                : undefined}
            {model.statusLine !== undefined ? <Text color="yellow">{model.statusLine}</Text> : undefined}
        </Box>
    );
}

function ApprovalDetail(props: { approval?: ApprovalRequest; mode: "approvalDetail" | "denyConfirm"; relatedCalls: ToolCallRecord[]; selectedAction?: "approve" | "deny" | "back" | "input"; toolCall?: ToolCallRecord }) {
    if (props.approval === undefined) {
        return <Text color="yellow">Approval is no longer pending. Back returns to the audit list.</Text>;
    }

    const fields = [
        ["instance", props.approval.instance],
        ["approval", props.approval.approvalId],
        ["call", props.approval.callId],
        ["source", props.approval.source],
        ["tool", props.approval.toolName],
        ["risk", props.approval.riskLevel],
        ["policy reason", props.approval.reason],
        ["requested time", props.approval.createdAt],
        ["expires", props.approval.expiresAt],
        ["remaining", remainingTime(props.approval.expiresAt)],
        ["input summary", props.toolCall?.inputSummary ?? props.approval.inputSummary]
    ] as const;
    const actions = props.mode === "approvalDetail" ? (["back", "input", "deny", "approve"] as const) : (["back", "deny"] as const);

    return (
        <Box flexDirection="column">
            <Text bold>{props.mode === "approvalDetail" ? "Approval Detail" : "Confirm Deny"}</Text>
            {fields.map(([label, value]) => (
                <Text key={label}>{`${label}: ${value}`}</Text>
            ))}
            <Text color="cyan">Input is available in structured full detail.</Text>
            {props.relatedCalls.length === 0 ? undefined : <Text dimColor>{`Nearby history: ${props.relatedCalls.map((call) => `${call.toolName}/${call.status}`).join(" · ")}`}</Text>}
            {props.mode === "denyConfirm" ? <Text color="yellow">Deny this approval?</Text> : undefined}
            <Box marginTop={1}>
                {actions.map((action) => (
                    <Text backgroundColor={props.selectedAction === action ? "cyan" : undefined} key={action}>{` ${action[0]!.toUpperCase()}${action.slice(1)} `}</Text>
                ))}
            </Box>
        </Box>
    );
}

function remainingTime(expiresAt: string): string {
    const milliseconds = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
        return "expired";
    }

    const seconds = Math.ceil(milliseconds / 1_000);
    const minutes = Math.floor(seconds / 60);
    return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}


export function buildFocusGraphForState(state: TuiAppState): TuiFocusGraph {
    switch (state.interaction.focusScope) {
        case "textDetail":
            return new TuiFocusGraph([]);
        case "confirm":
            return buildLinearGraph([
                { id: "cancel", kind: "button" as const },
                { id: "confirm", kind: "button" as const }
            ]);
        case "approvalDetail":
            return buildLinearGraph([
                { id: "back", kind: "approvalAction" as const },
                { id: "input", kind: "approvalAction" as const },
                { id: "deny", kind: "approvalAction" as const },
                { id: "approve", kind: "approvalAction" as const }
            ]);
        case "denyConfirm":
            return buildLinearGraph([
                { id: "back", kind: "approvalAction" as const },
                { id: "deny", kind: "approvalAction" as const }
            ]);
        case "search":
            return new TuiFocusGraph([{ item: { id: "search.query", kind: "field" } }]);
        case "toolForm":
            return new TuiFocusGraph([{ item: { id: "toolForm.input", kind: "field" } }]);
        case "form":
        case "wizard": {
            const box = selectMainScreenModel(state).boxes.find((candidate) => candidate.id === state.ui.mainFocusId);
            return buildLinearGraph(
                (box?.expandedLines ?? [])
                    .map((line) => ({
                        id: line.id!,
                        kind: line.id!.includes(":button:") ? ("button" as const) : ("field" as const)
                    }))
            );
        }
        case "sidebarPages":
        case "sidebarInstances":
            return buildLinearGraph([
                ...orderedPages.map((page) => ({ id: page, kind: "page" as const })),
                ...state.instances.map((instance) => ({ id: instance.name, kind: "instance" as const }))
            ]);
        case "mainBoxes":
            return buildLinearGraph(
                selectMainScreenModel(state).boxes.flatMap<TuiFocusItem>((box) =>
                    box.expanded ? box.expandedLines.map((line) => ({ boxId: box.id, id: line.id ?? line.text, kind: "line" as const })) : [{ id: box.id, kind: "box" as const }]
                )
            );
        case "boxDetail": {
            const box = selectMainScreenModel(state).boxes.find((candidate) => candidate.id === state.ui.mainFocusId);
            return buildLinearGraph((box?.expandedLines ?? []).map((line) => ({ boxId: box?.id ?? "", id: line.id ?? line.text, kind: "line" as const })));
        }
    }
}

function buildLinearGraph(items: TuiFocusItem[]): TuiFocusGraph {
    const nodes: TuiFocusNode[] = items.map((item, index) => ({
        down: items[(index + 1) % items.length],
        item,
        next: items[(index + 1) % items.length],
        previous: items[(index - 1 + items.length) % items.length],
        up: items[(index - 1 + items.length) % items.length]
    }));
    return new TuiFocusGraph(nodes);
}

function wrapText(value: string, width: number): string[] {
    const output: string[] = [];
    for (const sourceLine of value.split(/\r?\n/u)) {
        if (sourceLine.length === 0) {
            output.push("");
            continue;
        }
        for (let offset = 0; offset < sourceLine.length; offset += width) {
            output.push(sourceLine.slice(offset, offset + width));
        }
    }
    return output.length === 0 ? [""] : output;
}

function detailLineColor(line: string): string | undefined {
    const value = line.trimStart();
    if (/^(command|path|target|cwd):/u.test(value)) {
        return "yellow";
    }
    if (value.startsWith("+++") || value.startsWith("+")) {
        return "green";
    }
    if (value.startsWith("---") || value.startsWith("-")) {
        return "red";
    }
    if (value.startsWith("@@") || value.startsWith("***")) {
        return "cyan";
    }
    return undefined;
}
