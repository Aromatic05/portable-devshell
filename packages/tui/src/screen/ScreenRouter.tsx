import React from "react";
import { Box, Text } from "ink";

import { renderExpandableBoxLines } from "../component/ExpandableBox.js";
import { ErrorBanner } from "../component/ErrorBanner.js";
import { FocusGraph, type FocusNode } from "../interaction/FocusGraph.js";
import type { FocusItem } from "../interaction/TuiInteractionTypes.js";
import type { PageId } from "../model/TuiUiTypes.js";
import type { TuiAppState } from "../store/TuiReducers.js";
import { selectMainBoxFlowMetrics, selectMainBoxIds, selectMainScreenModel } from "../store/TuiSelectors.js";

export const orderedPages: PageId[] = ["instances", "config", "connector", "audit", "logs", "help"];

export interface ScreenRouterProps {
    boxInnerWidth: number;
    state: TuiAppState;
    viewportRows: number;
}

export function ScreenRouter(props: ScreenRouterProps) {
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

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

export function pageFromShortcut(index: number): PageId | undefined {
    return orderedPages[index - 1];
}

export function buildFocusGraphForState(state: TuiAppState): FocusGraph {
    switch (state.interaction.focusScope) {
        case "actionMenu":
            return buildLinearGraph(state.interaction.actionMenu.items.map((item) => ({ id: item.id, kind: "action" as const })));
        case "confirm":
            return buildLinearGraph([
                { id: "cancel", kind: "button" as const },
                { id: "confirm", kind: "button" as const }
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
                    .filter((line) => line.id?.includes(":field:") === true || line.id?.includes(":button:") === true)
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
            return buildLinearGraph(selectMainBoxIds(state).map((id) => ({ id, kind: "box" as const })));
        case "boxDetail": {
            const box = selectMainScreenModel(state).boxes.find((candidate) => candidate.id === state.ui.mainFocusId);
            return buildLinearGraph((box?.expandedLines ?? []).map((line) => ({ id: line.id ?? line.text, kind: "line" as const })));
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
