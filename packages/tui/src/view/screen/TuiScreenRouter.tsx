import { Box, Text } from "ink";

import { TuiFocusItem } from "../../state/focus/TuiFocusItem.js";
import { TuiFocusGraph, type TuiFocusNode } from "../../state/focus/TuiFocusGraph.js";
import type { TuiPageId } from "../../state/TuiUiState.js";
import { tuiPageOrder } from "../../state/TuiPageCatalog.js";
import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import type { TuiBoxModel } from "../../state/TuiViewModel.js";
import { renderExpandableBoxLines, type TuiComponentExpandableBoxRenderLine } from "../component/TuiComponentExpandableBox.js";
import { TuiComponentErrorBanner } from "../component/TuiComponentErrorBanner.js";
import { measureMainBoxFlowMetrics, selectMainBoxIds, selectMainScreenModel, selectMainScrollKey } from "../model/TuiViewProjection.js";
import { TuiOverviewView } from "../page/TuiOverviewView.js";

export const orderedPages: TuiPageId[] = [...tuiPageOrder];

export interface TuiScreenRouterProps {
    boxInnerWidth: number;
    state: TuiAppState;
    viewportRows: number;
}

export function TuiScreenRouter(props: TuiScreenRouterProps) {
    const model = selectMainScreenModel(props.state);
    if (props.state.ui.selectedPage === "overview") {
        const showOverview = model.loadState.kind === "ready" || model.loadState.kind === "stale";
        return (
            <Box flexDirection="column">
                {model.errorLines === undefined ? undefined : <TuiComponentErrorBanner lines={model.errorLines} />}
                <PageLoadState state={model.loadState} />
                {showOverview ? <TuiOverviewView state={props.state} viewportRows={props.viewportRows} width={props.boxInnerWidth} /> : undefined}
                {model.statusLine !== undefined ? <Text color="yellow">{model.statusLine}</Text> : undefined}
            </Box>
        );
    }
    const flow = measureMainBoxFlowMetrics(model.boxes, selectMainScrollKey(props.state), props.boxInnerWidth);
    const scrollOffset = props.state.ui.scrollOffsets[flow.scrollKey] ?? 0;
    const stateRows = model.loadState.kind === "ready" ? 0 : 1;
    const boxViewportRows = Math.max(0, props.viewportRows - 1 - stateRows - (model.statusLine === undefined ? 0 : 1) - (model.emptyState === undefined ? 0 : 1));
    const clampedOffset = clamp(scrollOffset, 0, Math.max(0, flow.totalLines - boxViewportRows));
    const visibleLines = boxViewportRows > 0
        ? renderVisibleBoxLines(model.boxes, flow.boxRanges, props.boxInnerWidth, clampedOffset, boxViewportRows)
        : [];

    return (
        <Box flexDirection="column">
            <Text bold>{model.pageTitle}</Text>
            {model.errorLines === undefined ? undefined : <TuiComponentErrorBanner lines={model.errorLines} />}
            <PageLoadState state={model.loadState} />
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

function PageLoadState(props: { state: ReturnType<typeof selectMainScreenModel>["loadState"] }) {
    switch (props.state.kind) {
        case "ready":
            return null;
        case "loading":
            return <Text color="cyan">Loading...</Text>;
        case "empty":
            return <Text dimColor>No data available.</Text>;
        case "failed":
            return <Text color="red">{`Load failed: ${props.state.error}`}</Text>;
        case "stale":
            return <Text color="yellow">{`Showing stale data: ${props.state.reason}`}</Text>;
    }
}

function renderVisibleBoxLines(
    boxes: readonly TuiBoxModel[],
    ranges: Record<string, { end: number; start: number }>,
    width: number,
    offset: number,
    viewportRows: number
): TuiComponentExpandableBoxRenderLine[] {
    const viewportEnd = offset + viewportRows;
    const visible: TuiComponentExpandableBoxRenderLine[] = [];
    for (const box of boxes) {
        const range = ranges[box.id];
        if (range === undefined || range.end <= offset) continue;
        if (range.start >= viewportEnd) break;
        const lines = renderExpandableBoxLines(box, width);
        visible.push(...lines.slice(
            Math.max(0, offset - range.start),
            Math.min(lines.length, viewportEnd - range.start)
        ));
    }
    return visible;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

export function buildFocusGraphForState(state: TuiAppState): TuiFocusGraph {
    switch (state.interaction.focusScope) {
        case "terminal":
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
        case "messageComposer":
            return new TuiFocusGraph([]);
        case "form":
        case "wizard": {
            const box = selectMainScreenModel(state).boxes.find((candidate) => candidate.id === state.ui.mainFocusId);
            return buildLinearGraph(
                (box?.expandedLines ?? []).map((line) => ({
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
            if (state.ui.selectedPage === "overview") {
                return buildLinearGraph(selectMainBoxIds(state).map((id) => ({ id, kind: "box" as const })));
            }
            return buildLinearGraph(
                selectMainScreenModel(state).boxes.flatMap<TuiFocusItem>((box) =>
                    box.expanded
                        ? box.expandedLines.map((line) => ({ boxId: box.id, id: line.id ?? line.text, kind: "line" as const }))
                        : [{ id: box.id, kind: "box" as const }]
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
