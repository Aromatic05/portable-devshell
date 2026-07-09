import React from "react";
import { Box, Text } from "ink";

import { ExpandableBox } from "../component/ExpandableBox.js";
import { FocusGraph, type FocusNode } from "../interaction/FocusGraph.js";
import type { FocusItem } from "../interaction/TuiInteractionTypes.js";
import type { PageId } from "../model/TuiUiTypes.js";
import type { TuiAppState } from "../store/TuiReducers.js";
import { selectMainBoxIds, selectMainScreenModel } from "../store/TuiSelectors.js";

export const orderedPages: PageId[] = ["instances", "config", "connector", "audit", "logs", "help"];

export interface ScreenRouterProps {
    state: TuiAppState;
}

export function ScreenRouter(props: ScreenRouterProps) {
    const model = selectMainScreenModel(props.state);
    const focusedBoxId = props.state.interaction.focusScope === "mainBoxes" || props.state.interaction.focusScope === "boxDetail" ? props.state.ui.mainFocusId : undefined;

    return (
        <Box flexDirection="column" gap={1}>
            <Text bold>{model.pageTitle}</Text>
            {model.emptyState !== undefined ? <Text color="yellow">{model.emptyState}</Text> : undefined}
            {model.boxes.map((box) => (
                <ExpandableBox
                    disabled={box.disabled}
                    expanded={box.expanded}
                    focused={focusedBoxId === box.id}
                    id={box.id}
                    key={box.id}
                    status={box.status}
                    summary={
                        <>
                            {box.summaryLines.map((line, index) => (
                                <Text key={`${box.id}-summary-${index}`}>{line}</Text>
                            ))}
                        </>
                    }
                    title={box.title}
                >
                    {box.detailLines.map((line, index) => (
                        <Text key={`${box.id}-detail-${index}`}>{line}</Text>
                    ))}
                </ExpandableBox>
            ))}
            {model.statusLine !== undefined ? <Text color="yellow">{model.statusLine}</Text> : undefined}
        </Box>
    );
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
        case "sidebarPages":
            return buildLinearGraph(orderedPages.map((page) => ({ id: page, kind: "page" as const })));
        case "sidebarInstances":
            return buildLinearGraph(state.instances.map((instance) => ({ id: instance.name, kind: "instance" as const })));
        case "boxDetail":
        case "mainBoxes":
            return buildLinearGraph(selectMainBoxIds(state).map((id) => ({ id, kind: "box" as const })));
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
