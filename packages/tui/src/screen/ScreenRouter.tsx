import React from "react";
import { Box, Text } from "ink";
import type { ApprovalRequest } from "@portable-devshell/shared";

import { renderExpandableBoxLines } from "../component/ExpandableBox.js";
import { ErrorBanner } from "../component/ErrorBanner.js";
import { FocusGraph, type FocusNode } from "../interaction/FocusGraph.js";
import type { FocusItem } from "../interaction/TuiInteractionTypes.js";
import type { PageId } from "../model/TuiUiTypes.js";
import type { TuiAppState } from "../store/TuiReducers.js";
import { selectMainBoxFlowMetrics, selectMainScreenModel } from "../store/TuiSelectors.js";

export const orderedPages: PageId[] = ["instances", "config", "connector", "oauth", "audit", "logs", "help"];

export interface ScreenRouterProps {
    boxInnerWidth: number;
    state: TuiAppState;
    viewportRows: number;
}

export function ScreenRouter(props: ScreenRouterProps) {
    const textDetail = props.state.interaction.textDetail;
    if (textDetail.open) {
        const width = Math.max(20, props.boxInnerWidth);
        const lines = wrapText(textDetail.body, width);
        const viewport = Math.max(1, props.viewportRows - 2);
        const offset = clamp(textDetail.scrollOffset, 0, Math.max(0, lines.length - viewport));
        return (
            <Box flexDirection="column">
                <Text bold>{textDetail.title}</Text>
                {lines.slice(offset, offset + viewport).map((line, index) => <Text key={`${offset + index}:${line}`}>{line}</Text>)}
                <Text dimColor>{`line ${Math.min(offset + 1, Math.max(lines.length, 1))}-${Math.min(offset + viewport, lines.length)} / ${lines.length} · Esc/Enter back`}</Text>
            </Box>
        );
    }
    const auditPage = props.state.interaction.auditPage;
    if (props.state.ui.selectedPage === "audit" && auditPage.mode !== "list") {
        const approval = (props.state.approvalsByInstance[props.state.ui.selectedInstance ?? ""] ?? []).find(
            (candidate) => candidate.approvalId === auditPage.approvalId
        );
        return <ApprovalDetail approval={approval} mode={auditPage.mode} selectedAction={auditPage.selectedAction} />;
    }
    const model = selectMainScreenModel(props.state);
    const flow = selectMainBoxFlowMetrics(props.state);
    const scrollOffset = props.state.ui.scrollOffsets[flow.scrollKey] ?? 0;
    const boxViewportRows = Math.max(0, props.viewportRows - 1 - (model.statusLine === undefined ? 0 : 1) - (model.emptyState === undefined ? 0 : 1));
    const renderedLines = model.boxes.flatMap((box) => renderExpandableBoxLines(box, props.boxInnerWidth));
    const clampedOffset = clamp(scrollOffset, 0, Math.max(0, renderedLines.length - boxViewportRows));
    const visibleLines = boxViewportRows > 0 ? renderedLines.slice(clampedOffset, clampedOffset + boxViewportRows) : [];

    return (
        <Box flexDirection="column">
            <Text bold>{model.pageTitle}</Text>
            {model.errorLines === undefined ? undefined : <ErrorBanner lines={model.errorLines} />}
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

function ApprovalDetail(props: { approval?: ApprovalRequest; mode: "approvalDetail" | "denyConfirm"; selectedAction?: "approve" | "deny" | "back" }) {
    if (props.approval === undefined) {
        return <Text color="yellow">Approval is no longer pending. Back returns to the audit list.</Text>;
    }

    const fields = [
        ["instance", props.approval.instance],
        ["source", props.approval.source],
        ["tool", props.approval.toolName],
        ["risk", props.approval.riskLevel],
        ["reason", props.approval.reason],
        ["input", props.approval.inputSummary],
        ["requested time", props.approval.createdAt]
    ] as const;
    const actions = props.mode === "approvalDetail" ? (["back", "deny", "approve"] as const) : (["back", "deny"] as const);

    return (
        <Box flexDirection="column">
            <Text bold>{props.mode === "approvalDetail" ? "Approval Detail" : "Confirm Deny"}</Text>
            {fields.map(([label, value]) => (
                <Text key={label}>{`${label}: ${value}`}</Text>
            ))}
            {props.mode === "denyConfirm" ? <Text color="yellow">Deny this approval?</Text> : undefined}
            <Box marginTop={1}>
                {actions.map((action) => (
                    <Text backgroundColor={props.selectedAction === action ? "cyan" : undefined} key={action}>{` ${action[0]!.toUpperCase()}${action.slice(1)} `}</Text>
                ))}
            </Box>
        </Box>
    );
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

export function pageFromShortcut(index: number): PageId | undefined {
    return orderedPages[index - 1];
}

export function buildFocusGraphForState(state: TuiAppState): FocusGraph {
    switch (state.interaction.focusScope) {
        case "textDetail":
            return new FocusGraph([]);
        case "confirm":
            return buildLinearGraph([
                { id: "cancel", kind: "button" as const },
                { id: "confirm", kind: "button" as const }
            ]);
        case "approvalDetail":
            return buildLinearGraph([
                { id: "back", kind: "approvalAction" as const },
                { id: "deny", kind: "approvalAction" as const },
                { id: "approve", kind: "approvalAction" as const }
            ]);
        case "denyConfirm":
            return buildLinearGraph([
                { id: "back", kind: "approvalAction" as const },
                { id: "deny", kind: "approvalAction" as const }
            ]);
        case "search":
            return new FocusGraph([{ item: { id: "search.query", kind: "field" } }]);
        case "toolForm":
            return new FocusGraph([{ item: { id: "toolForm.input", kind: "field" } }]);
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
                selectMainScreenModel(state).boxes.flatMap<FocusItem>((box) =>
                    box.expanded ? box.expandedLines.map((line) => ({ boxId: box.id, id: line.id ?? line.text, kind: "line" as const })) : [{ id: box.id, kind: "box" as const }]
                )
            );
        case "boxDetail": {
            const box = selectMainScreenModel(state).boxes.find((candidate) => candidate.id === state.ui.mainFocusId);
            return buildLinearGraph((box?.expandedLines ?? []).map((line) => ({ boxId: box?.id ?? "", id: line.id ?? line.text, kind: "line" as const })));
        }
    }
}

function buildLinearGraph(items: FocusItem[]): FocusGraph {
    const nodes: FocusNode[] = items.map((item, index) => ({
        down: items[(index + 1) % items.length],
        item,
        next: items[(index + 1) % items.length],
        previous: items[(index - 1 + items.length) % items.length],
        up: items[(index - 1 + items.length) % items.length]
    }));
    return new FocusGraph(nodes);
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
