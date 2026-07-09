import React from "react";
import { Box, Text } from "ink";

import { FocusGraph, type FocusNode } from "../interaction/FocusGraph.js";
import { isSameFocusItem, type FocusItem, type TuiActionMenuItem, type TuiUiIntent } from "../interaction/TuiInteractionTypes.js";
import type { TuiAppState, TuiPanel } from "../store/TuiReducers.js";
import {
    selectApprovalCards,
    selectApprovalLines,
    selectAuditCards,
    selectAuditLines,
    selectConnectorLines,
    selectExpanded,
    selectHelpLines,
    selectInstanceDetailLines,
    selectInstanceRows,
    selectLogLines,
    selectLogViewport,
    selectPanelTitle
} from "../store/TuiSelectors.js";

export const orderedPanels: TuiPanel[] = ["instances", "connector", "audit", "logs", "approvals", "help"];

export interface ScreenRouterProps {
    state: TuiAppState;
}

export interface TuiScreenDefinition {
    actionMenu: { items: TuiActionMenuItem[]; title: string };
    activate(item: FocusItem, state: TuiAppState): TuiUiIntent[];
    focusGraph: FocusGraph;
    handleIntent(intent: "end" | "home" | "pageDown" | "pageUp", state: TuiAppState): TuiUiIntent[];
    panel: TuiPanel;
    toggle(item: FocusItem, state: TuiAppState): TuiUiIntent[];
}

export function ScreenRouter(props: ScreenRouterProps) {
    switch (props.state.activePanel) {
        case "instances":
            return <InstancesScreen state={props.state} />;
        case "connector":
            return <LinesScreen focusPrefix="connector" lines={selectConnectorLines(props.state)} state={props.state} title={selectPanelTitle("connector")} />;
        case "audit":
            return <CardsScreen cards={selectAuditCards(props.state)} focusPrefix="audit" state={props.state} title={selectPanelTitle("audit")} />;
        case "logs":
            return <LinesScreen focusPrefix="logs" lines={selectLogLines(props.state)} state={props.state} title={selectPanelTitle("logs")} />;
        case "approvals":
            return <CardsScreen cards={selectApprovalCards(props.state)} focusPrefix="approvals" state={props.state} title={selectPanelTitle("approvals")} />;
        case "help":
            return <LinesScreen focusPrefix="help" lines={selectHelpLines(props.state)} state={props.state} title={selectPanelTitle("help")} />;
    }
}

export function buildScreenDefinition(state: TuiAppState): TuiScreenDefinition {
    switch (state.activePanel) {
        case "instances":
            return buildInstancesDefinition(state);
        case "connector":
            return buildLinesDefinition(state, "connector", selectConnectorLines(state));
        case "audit":
            return buildCardDefinition(state, "audit", selectAuditCards(state), selectAuditLines(state));
        case "logs":
            return buildLinesDefinition(state, "logs", selectLogLines(state));
        case "approvals":
            return buildCardDefinition(state, "approvals", selectApprovalCards(state), selectApprovalLines(state));
        case "help":
            return buildLinesDefinition(state, "help", selectHelpLines(state));
    }
}

export function buildFocusGraphForState(state: TuiAppState): FocusGraph {
    if (state.interaction.mode === "actionMenu") {
        return new FocusGraph(
            state.interaction.actionMenu.items.map((item, index, items) => ({
                down: items.length <= 1 ? undefined : ({ kind: "action", id: items[(index + 1) % items.length]?.id ?? item.id } as FocusItem),
                item: { kind: "action", id: item.id },
                next: items.length <= 1 ? undefined : ({ kind: "action", id: items[(index + 1) % items.length]?.id ?? item.id } as FocusItem),
                previous:
                    items.length <= 1 ? undefined : ({ kind: "action", id: items[(index - 1 + items.length) % items.length]?.id ?? item.id } as FocusItem),
                up: items.length <= 1 ? undefined : ({ kind: "action", id: items[(index - 1 + items.length) % items.length]?.id ?? item.id } as FocusItem)
            }))
        );
    }

    if (state.interaction.mode === "confirm") {
        return new FocusGraph([
            {
                item: { kind: "button", id: "cancel" },
                left: { kind: "button", id: "confirm" },
                next: { kind: "button", id: "confirm" },
                previous: { kind: "button", id: "confirm" },
                right: { kind: "button", id: "confirm" }
            },
            {
                item: { kind: "button", id: "confirm" },
                left: { kind: "button", id: "cancel" },
                next: { kind: "button", id: "cancel" },
                previous: { kind: "button", id: "cancel" },
                right: { kind: "button", id: "cancel" }
            }
        ]);
    }

    if (state.interaction.mode === "search") {
        return new FocusGraph([{ item: { kind: "field", id: "search.query" } }]);
    }

    return buildScreenDefinition(state).focusGraph;
}

export function panelFromShortcut(index: number): TuiPanel | undefined {
    return orderedPanels[index - 1];
}

export function panelLabel(panel: TuiPanel): string {
    return selectPanelTitle(panel);
}

export function nextPanel(panel: TuiPanel): TuiPanel {
    const index = orderedPanels.indexOf(panel);
    return orderedPanels[(index + 1) % orderedPanels.length] ?? "instances";
}

export function previousPanel(panel: TuiPanel): TuiPanel {
    const index = orderedPanels.indexOf(panel);
    return orderedPanels[(index - 1 + orderedPanels.length) % orderedPanels.length] ?? "instances";
}

function InstancesScreen(props: ScreenRouterProps) {
    const rows = filterLines(selectInstanceRows(props.state), props.state.interaction.search.query);
    const detailLines = selectInstanceDetailLines(props.state);
    const currentFocus = props.state.interaction.currentFocus;
    const expanded = props.state.interaction.screenToggleByPanel.instances !== false;

    return (
        <Box flexDirection="column" gap={1}>
            <Text bold>{selectPanelTitle("instances")}</Text>
            <FocusableCard focused={isFocused(currentFocus, { kind: "card", id: "instances.summary" })} text={`instances ${props.state.instances.length}`} />
            <Box gap={2}>
                <Box flexDirection="column" width="65%">
                    {rows.map((row, index) => (
                        <Text color={isFocused(currentFocus, { kind: "listItem", id: `instances.row.${index}` }) ? "cyan" : undefined} key={`${row}-${index}`}>
                            {row}
                        </Text>
                    ))}
                </Box>
                <Box flexDirection="column" width="35%">
                    <Text color={isFocused(currentFocus, { kind: "card", id: "instances.detail" }) ? "cyan" : undefined}>Selected Detail</Text>
                    {(expanded ? detailLines : detailLines.slice(0, 1)).map((line, index) => (
                        <Text key={`${line}-${index}`}>{line}</Text>
                    ))}
                </Box>
            </Box>
            <ScreenStatus state={props.state} />
        </Box>
    );
}

function LinesScreen(props: ScreenRouterProps & { focusPrefix: string; lines: string[]; title: string }) {
    const currentFocus = props.state.interaction.currentFocus;

    return (
        <Box flexDirection="column" gap={1}>
            <Text bold>{props.title}</Text>
            <FocusableCard focused={isFocused(currentFocus, { kind: "card", id: `${props.focusPrefix}.summary` })} text={props.lines[0] ?? "No data."} />
            <Box flexDirection="column">
                {props.lines.slice(1).map((line, index) => (
                    <Text color={isFocused(currentFocus, { kind: "listItem", id: `${props.focusPrefix}.row.${index}` }) ? "cyan" : undefined} key={`${line}-${index}`}>
                        {line}
                    </Text>
                ))}
            </Box>
            {props.focusPrefix === "logs" ? <Text>{`follow ${selectLogViewport(props.state).follow ? "on" : "off"}`}</Text> : undefined}
            <ScreenStatus state={props.state} />
        </Box>
    );
}

function CardsScreen(props: ScreenRouterProps & { cards: Array<{ expanded: boolean; id: string; lines: Array<{ text: string }> }>; focusPrefix: string; title: string }) {
    const currentFocus = props.state.interaction.currentFocus;

    return (
        <Box flexDirection="column" gap={1}>
            <Text bold>{props.title}</Text>
            <FocusableCard focused={isFocused(currentFocus, { kind: "card", id: `${props.focusPrefix}.summary` })} text={`${props.cards.length} cards`} />
            <Box flexDirection="column">
                {props.cards.map((card, index) => (
                    <Box flexDirection="column" key={card.id}>
                        {card.lines.map((line, lineIndex) => (
                            <Text
                                color={lineIndex === 0 && isFocused(currentFocus, { kind: "listItem", id: `${props.focusPrefix}.row.${index}` }) ? "cyan" : undefined}
                                key={`${card.id}-${lineIndex}`}
                            >
                                {line.text}
                            </Text>
                        ))}
                    </Box>
                ))}
            </Box>
            <ScreenStatus state={props.state} />
        </Box>
    );
}

function buildInstancesDefinition(state: TuiAppState): TuiScreenDefinition {
    const rows = filterLines(selectInstanceRows(state), state.interaction.search.query);
    const nodes: FocusNode[] = [
        {
            down: rows[0] === undefined ? ({ kind: "card", id: "instances.detail" } as FocusItem) : ({ kind: "listItem", id: "instances.row.0" } as FocusItem),
            item: { kind: "card", id: "instances.summary" } as FocusItem
        }
    ];

    rows.forEach((_, index) => {
        nodes.push({
            down: index === rows.length - 1 ? ({ kind: "card", id: "instances.detail" } as FocusItem) : ({ kind: "listItem", id: `instances.row.${index + 1}` } as FocusItem),
            item: { kind: "listItem", id: `instances.row.${index}` },
            next: { kind: "listItem", id: `instances.row.${(index + 1) % rows.length}` },
            previous: { kind: "listItem", id: `instances.row.${(index - 1 + rows.length) % rows.length}` },
            up: index === 0 ? ({ kind: "card", id: "instances.summary" } as FocusItem) : ({ kind: "listItem", id: `instances.row.${index - 1}` } as FocusItem)
        });
    });

    nodes.push({
        item: { kind: "card", id: "instances.detail" },
        next: { kind: "card", id: "instances.summary" },
        previous: rows.length === 0 ? ({ kind: "card", id: "instances.summary" } as FocusItem) : ({ kind: "listItem", id: `instances.row.${rows.length - 1}` } as FocusItem),
        up: rows.length === 0 ? ({ kind: "card", id: "instances.summary" } as FocusItem) : ({ kind: "listItem", id: `instances.row.${rows.length - 1}` } as FocusItem)
    });

    const graph = new FocusGraph(nodes);

    return {
        actionMenu: {
            items: [
                { id: "instances.readonly", intent: { panel: "instances", status: "Read-only action menu placeholder.", type: "screen.setStatus" }, label: "Read-only placeholder" }
            ],
            title: "Instances Actions"
        },
        activate(item) {
            if (item.kind === "listItem") {
                return [
                    { panel: "instances", status: "Opened selected instance detail without starting worker.", type: "screen.setStatus" },
                    { panel: "instances", type: "screen.setToggle", value: true }
                ];
            }

            return [{ panel: "instances", status: "Focused instances detail.", type: "screen.setStatus" }];
        },
        focusGraph: graph,
        handleIntent(intent) {
            if (intent === "home") {
                return [{ item: graph.first() ?? { kind: "card", id: "instances.summary" }, type: "focus.set" }];
            }

            if (intent === "end") {
                return [{ item: { kind: "card", id: "instances.detail" }, type: "focus.set" }];
            }

            return [{ panel: "instances", status: `${intent} handled by instances panel.`, type: "screen.setStatus" }];
        },
        panel: "instances",
        toggle() {
            return [
                { panel: "instances", type: "screen.setToggle", value: state.interaction.screenToggleByPanel.instances === false },
                {
                    panel: "instances",
                    status: state.interaction.screenToggleByPanel.instances === false ? "Expanded selected instance detail." : "Collapsed selected instance detail.",
                    type: "screen.setStatus"
                }
            ];
        }
    };
}

function buildLinesDefinition(state: TuiAppState, panel: TuiPanel, lines: string[]): TuiScreenDefinition {
    const filteredLines = filterLines(lines, state.interaction.search.query);
    const nodes: FocusNode[] = [
        {
            down: filteredLines.length > 1 ? ({ kind: "listItem", id: `${panel}.row.0` } as FocusItem) : undefined,
            item: { kind: "card", id: `${panel}.summary` } as FocusItem
        }
    ];

    filteredLines.slice(1).forEach((_, index, entries) => {
        nodes.push({
            down: index === entries.length - 1 ? ({ kind: "card", id: `${panel}.summary` } as FocusItem) : ({ kind: "listItem", id: `${panel}.row.${index + 1}` } as FocusItem),
            item: { kind: "listItem", id: `${panel}.row.${index}` },
            next: { kind: "listItem", id: `${panel}.row.${(index + 1) % entries.length}` },
            previous: { kind: "listItem", id: `${panel}.row.${(index - 1 + entries.length) % entries.length}` },
            up: index === 0 ? ({ kind: "card", id: `${panel}.summary` } as FocusItem) : ({ kind: "listItem", id: `${panel}.row.${index - 1}` } as FocusItem)
        });
    });

    const graph = new FocusGraph(nodes);

    return {
        actionMenu: {
            items: [{ id: `${panel}.readonly`, intent: { panel, status: "Read-only action menu placeholder.", type: "screen.setStatus" }, label: "Read-only placeholder" }],
            title: `${panelLabel(panel)} Actions`
        },
        activate(item) {
            return [{ panel, status: `Focused ${item.id}.`, type: "screen.setStatus" }];
        },
        focusGraph: graph,
        handleIntent(intent) {
            if (intent === "home") {
                return [{ item: graph.first() ?? { kind: "card", id: `${panel}.summary` }, type: "focus.set" }];
            }

            if (intent === "end") {
                return [{ item: graph.last() ?? { kind: "card", id: `${panel}.summary` }, type: "focus.set" }];
            }

            return [{ panel, status: `${intent} handled by ${panelLabel(panel)}.`, type: "screen.setStatus" }];
        },
        panel,
        toggle() {
            return [{ panel, status: `${panelLabel(panel)} is read-only.`, type: "screen.setStatus" }];
        }
    };
}

function buildCardDefinition(
    state: TuiAppState,
    panel: "audit" | "approvals",
    cards: Array<{ id: string }>,
    lines: string[]
): TuiScreenDefinition {
    const filteredLines = filterLines(lines, state.interaction.search.query);
    const nodes: FocusNode[] = [
        {
            down: cards[0] === undefined ? undefined : ({ kind: "listItem", id: `${panel}.row.0` } as FocusItem),
            item: { kind: "card", id: `${panel}.summary` } as FocusItem
        }
    ];

    cards.forEach((_, index) => {
        nodes.push({
            down: index === cards.length - 1 ? ({ kind: "card", id: `${panel}.summary` } as FocusItem) : ({ kind: "listItem", id: `${panel}.row.${index + 1}` } as FocusItem),
            item: { kind: "listItem", id: `${panel}.row.${index}` },
            next: { kind: "listItem", id: `${panel}.row.${(index + 1) % cards.length}` },
            previous: { kind: "listItem", id: `${panel}.row.${(index - 1 + cards.length) % cards.length}` },
            up: index === 0 ? ({ kind: "card", id: `${panel}.summary` } as FocusItem) : ({ kind: "listItem", id: `${panel}.row.${index - 1}` } as FocusItem)
        });
    });

    const graph = new FocusGraph(nodes);

    return {
        actionMenu: {
            items: [{ id: `${panel}.readonly`, intent: { panel, status: "Read-only action menu placeholder.", type: "screen.setStatus" }, label: "Read-only placeholder" }],
            title: `${panelLabel(panel)} Actions`
        },
        activate(item) {
            if (item.kind === "listItem") {
                const index = Number(item.id.split(".").at(-1));
                const card = cards[index];

                if (card !== undefined) {
                    return [
                        { key: card.id, type: "ui.toggleExpanded" },
                        { panel, status: `${selectExpanded(state, card.id) ? "Collapsed" : "Expanded"} ${panel} card.`, type: "screen.setStatus" }
                    ];
                }
            }

            return [{ panel, status: `${panelLabel(panel)} focused.`, type: "screen.setStatus" }];
        },
        focusGraph: graph,
        handleIntent(intent) {
            if (intent === "home") {
                return [{ item: graph.first() ?? { kind: "card", id: `${panel}.summary` }, type: "focus.set" }];
            }

            if (intent === "end") {
                return [{ item: graph.last() ?? (filteredLines.length === 0 ? { kind: "card", id: `${panel}.summary` } : { kind: "listItem", id: `${panel}.row.${cards.length - 1}` }), type: "focus.set" }];
            }

            return [{ panel, status: `${intent} handled by ${panelLabel(panel)}.`, type: "screen.setStatus" }];
        },
        panel,
        toggle(item) {
            if (item.kind !== "listItem") {
                return [{ panel, status: `${panelLabel(panel)} is read-only.`, type: "screen.setStatus" }];
            }

            const index = Number(item.id.split(".").at(-1));
            const card = cards[index];

            if (card === undefined) {
                return [{ panel, status: "No card selected.", type: "screen.setStatus" }];
            }

            return [
                { key: card.id, type: "ui.toggleExpanded" },
                { panel, status: `${selectExpanded(state, card.id) ? "Collapsed" : "Expanded"} ${panel} card.`, type: "screen.setStatus" }
            ];
        }
    };
}

function FocusableCard(props: { focused: boolean; text: string }) {
    return <Text color={props.focused ? "cyan" : undefined}>{props.text}</Text>;
}

function ScreenStatus(props: { state: TuiAppState }) {
    const status = props.state.interaction.screenStatusByPanel[props.state.activePanel];

    if (typeof status !== "string" || status.length === 0) {
        return null;
    }

    return <Text color="yellow">{status}</Text>;
}

function filterLines(lines: string[], query: string): string[] {
    if (query.length === 0) {
        return lines;
    }

    return lines.filter((line) => line.toLowerCase().includes(query.toLowerCase()));
}

function isFocused(current: FocusItem | undefined, item: FocusItem): boolean {
    return isSameFocusItem(current, item);
}
