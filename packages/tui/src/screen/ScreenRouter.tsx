import React from "react";
import { Box, Text } from "ink";

import { FocusGraph, type FocusNode } from "../interaction/FocusGraph.js";
import { focusItemKey, isSameFocusItem, type FocusItem, type TuiActionMenuItem, type TuiUiIntent } from "../interaction/TuiInteractionTypes.js";
import type { TuiAppState, TuiPanel } from "../store/TuiReducers.js";
import {
    selectAuditLines,
    selectConfigLines,
    selectConnectorLines,
    selectHelpLines,
    selectInstanceRows,
    selectLogLines,
    selectPanelTitle
} from "../store/TuiSelectors.js";

export const orderedPanels: TuiPanel[] = ["instances", "config", "connector", "audit", "logs", "help"];

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
        case "config":
            return <ConfigScreen state={props.state} />;
        case "connector":
            return <LinesScreen focusPrefix="connector" lines={selectConnectorLines(props.state)} state={props.state} title={selectPanelTitle("connector")} />;
        case "audit":
            return <LinesScreen focusPrefix="audit" lines={selectAuditLines(props.state)} state={props.state} title={selectPanelTitle("audit")} />;
        case "logs":
            return <LinesScreen focusPrefix="logs" lines={selectLogLines(props.state)} state={props.state} title={selectPanelTitle("logs")} />;
        case "help":
            return <LinesScreen focusPrefix="help" lines={selectHelpLines()} state={props.state} title={selectPanelTitle("help")} />;
    }
}

export function buildScreenDefinition(state: TuiAppState): TuiScreenDefinition {
    switch (state.activePanel) {
        case "instances":
            return buildInstancesDefinition(state);
        case "config":
            return buildConfigDefinition(state);
        case "connector":
            return buildLinesDefinition(state, "connector", selectConnectorLines(state));
        case "audit":
            return buildLinesDefinition(state, "audit", selectAuditLines(state));
        case "logs":
            return buildLinesDefinition(state, "logs", selectLogLines(state));
        case "help":
            return buildLinesDefinition(state, "help", selectHelpLines());
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
    const rows = selectInstanceRows(props.state);
    const filteredRows = filterLines(rows, props.state.interaction.search.query);
    const currentFocus = props.state.interaction.currentFocus;

    return (
        <Box flexDirection="column" gap={1}>
            <Text bold>{selectPanelTitle("instances")}</Text>
            <FocusableCard focused={isFocused(currentFocus, { kind: "card", id: "instances.summary" })} text={`instances ${props.state.instances.length}`} />
            <Box flexDirection="column">
                {filteredRows.map((row, index) => (
                    <Text
                        color={isFocused(currentFocus, { kind: "listItem", id: `instances.row.${index}` }) ? "cyan" : undefined}
                        key={`${row}-${index}`}
                    >
                        {row}
                    </Text>
                ))}
            </Box>
            <ScreenStatus state={props.state} />
        </Box>
    );
}

function ConfigScreen(props: ScreenRouterProps) {
    const currentFocus = props.state.interaction.currentFocus;
    const toggleValue = props.state.interaction.screenToggleByPanel.config === true;
    const dirty = props.state.interaction.dirty;

    return (
        <Box flexDirection="column" gap={1}>
            <Text bold>{selectPanelTitle("config")}</Text>
            <FocusableCard focused={isFocused(currentFocus, { kind: "card", id: "config.summary" })} text={selectConfigLines(props.state)[0] ?? "Config view unavailable."} />
            <Text color={isFocused(currentFocus, { kind: "field", id: "config.localToggle" }) ? "cyan" : undefined}>
                {`[${toggleValue ? "x" : " "}] Local edit toggle preview`}
            </Text>
            <Box gap={1}>
                <FocusableButton focused={isFocused(currentFocus, { kind: "button", id: "save" })} label={dirty ? "Save" : "Save (disabled view)"} />
                <FocusableButton focused={isFocused(currentFocus, { kind: "button", id: "cancel" })} label={dirty ? "Cancel" : "Cancel"} />
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
            <ScreenStatus state={props.state} />
        </Box>
    );
}

function buildInstancesDefinition(state: TuiAppState): TuiScreenDefinition {
    const rows = filterLines(selectInstanceRows(state), state.interaction.search.query);
    const nodes: FocusNode[] = [
        { down: rows[0] === undefined ? undefined : { kind: "listItem", id: "instances.row.0" } as FocusItem, item: { kind: "card", id: "instances.summary" } as FocusItem }
    ];

    rows.forEach((_, index) => {
        nodes.push({
            item: { kind: "listItem", id: `instances.row.${index}` },
            next: { kind: "listItem", id: `instances.row.${(index + 1) % rows.length}` },
            previous: { kind: "listItem", id: `instances.row.${(index - 1 + rows.length) % rows.length}` },
            up: index === 0 ? { kind: "card", id: "instances.summary" } : { kind: "listItem", id: `instances.row.${index - 1}` },
            down: index === rows.length - 1 ? { kind: "card", id: "instances.summary" } : { kind: "listItem", id: `instances.row.${index + 1}` }
        });
    });

    const graph = new FocusGraph(nodes);

    return {
        actionMenu: {
            items: [
                { id: "instances.mark", intent: { panel: "instances", status: "Marked instances panel as reviewed.", type: "screen.setStatus" }, label: "Mark reviewed" },
                { id: "instances.help", intent: { panel: "help", type: "panel.activate" }, label: "Open help panel" }
            ],
            title: "Instances Actions"
        },
        activate(item) {
            return [
                {
                    panel: "instances",
                    status: item.kind === "listItem" ? `Activated ${item.id}.` : "Activated instances summary.",
                    type: "screen.setStatus"
                }
            ];
        },
        focusGraph: graph,
        handleIntent(intent) {
            if (intent === "home") {
                return [{ item: graph.first() ?? { kind: "card", id: "instances.summary" }, type: "focus.set" }];
            }

            if (intent === "end") {
                return [{ item: graph.last() ?? { kind: "card", id: "instances.summary" }, type: "focus.set" }];
            }

            return [{ panel: "instances", status: `${intent} handled by instances panel.`, type: "screen.setStatus" }];
        },
        panel: "instances",
        toggle(_item, panelState) {
            const nextValue = panelState.interaction.screenToggleByPanel.instances !== true;
            return [
                { panel: "instances", type: "screen.setToggle", value: nextValue },
                { panel: "instances", status: nextValue ? "Instances panel expanded." : "Instances panel collapsed.", type: "screen.setStatus" }
            ];
        }
    };
}

function buildConfigDefinition(state: TuiAppState): TuiScreenDefinition {
    const summary = { kind: "card", id: "config.summary" } as FocusItem;
    const field = { kind: "field", id: "config.localToggle" } as FocusItem;
    const save = { kind: "button", id: "save" } as FocusItem;
    const cancel = { kind: "button", id: "cancel" } as FocusItem;
    const graph = new FocusGraph([
        { down: field, item: summary, next: field, previous: cancel },
        { down: save, item: field, next: save, previous: summary, up: summary },
        { item: save, left: field, next: cancel, previous: field, right: cancel, up: field },
        { item: cancel, left: save, next: summary, previous: save, right: save, up: field }
    ]);

    return {
        actionMenu: {
            items: [
                { id: "config.focusSave", intent: { item: save, type: "focus.set" }, label: "Focus save" },
                { id: "config.clearDraft", intent: { panel: "config", status: "Local draft cleared.", type: "screen.setStatus" }, label: "Clear draft note" }
            ],
            title: "Config Actions"
        },
        activate(item, panelState) {
            if (item.kind === "field") {
                const nextValue = panelState.interaction.screenToggleByPanel.config !== true;
                return [
                    { panel: "config", type: "screen.setToggle", value: nextValue },
                    { type: "edit.setDirty", value: true },
                    { mode: "edit", type: "mode.set" },
                    { panel: "config", status: `Local toggle set to ${nextValue ? "on" : "off"}.`, type: "screen.setStatus" }
                ];
            }

            if (item.kind === "button" && item.id === "save") {
                return [
                    { type: "edit.setDirty", value: false },
                    { mode: "normal", type: "mode.set" },
                    { panel: "config", status: "Local config draft saved.", type: "screen.setStatus" }
                ];
            }

            if (item.kind === "button" && item.id === "cancel") {
                return [
                    { panel: "config", type: "screen.setToggle", value: false },
                    { type: "edit.setDirty", value: false },
                    { mode: "normal", type: "mode.set" },
                    { panel: "config", status: "Local config draft discarded.", type: "screen.setStatus" }
                ];
            }

            return [{ panel: "config", status: "Activated config summary.", type: "screen.setStatus" }];
        },
        focusGraph: graph,
        handleIntent(intent) {
            if (intent === "home") {
                return [{ item: summary, type: "focus.set" }];
            }

            if (intent === "end") {
                return [{ item: cancel, type: "focus.set" }];
            }

            return [{ panel: "config", status: `${intent} handled by config panel.`, type: "screen.setStatus" }];
        },
        panel: "config",
        toggle(item, panelState) {
            if (item.kind !== "field") {
                return [{ panel: "config", status: "Nothing to toggle for current focus.", type: "screen.setStatus" }];
            }

            const nextValue = panelState.interaction.screenToggleByPanel.config !== true;
            return [
                { panel: "config", type: "screen.setToggle", value: nextValue },
                { type: "edit.setDirty", value: true },
                { mode: "edit", type: "mode.set" },
                { panel: "config", status: nextValue ? "Config toggle enabled." : "Config toggle disabled.", type: "screen.setStatus" }
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
            item: { kind: "listItem", id: `${panel}.row.${index}` },
            next: { kind: "listItem", id: `${panel}.row.${(index + 1) % entries.length}` },
            previous: { kind: "listItem", id: `${panel}.row.${(index - 1 + entries.length) % entries.length}` },
            up: index === 0 ? { kind: "card", id: `${panel}.summary` } : { kind: "listItem", id: `${panel}.row.${index - 1}` },
            down: index === entries.length - 1 ? { kind: "card", id: `${panel}.summary` } : { kind: "listItem", id: `${panel}.row.${index + 1}` }
        });
    });

    const graph = new FocusGraph(nodes);

    return {
        actionMenu: {
            items: [
                { id: `${panel}.note`, intent: { panel, status: `${panelLabel(panel)} action executed.`, type: "screen.setStatus" }, label: "Write local note" },
                { id: `${panel}.instances`, intent: { panel: "instances", type: "panel.activate" }, label: "Back to instances" }
            ],
            title: `${panelLabel(panel)} Actions`
        },
        activate(item) {
            return [{ panel, status: `Activated ${focusItemKey(item)}.`, type: "screen.setStatus" }];
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
        toggle(_item, panelState) {
            const nextValue = panelState.interaction.screenToggleByPanel[panel] !== true;
            return [
                { panel, type: "screen.setToggle", value: nextValue },
                { panel, status: nextValue ? `${panelLabel(panel)} expanded.` : `${panelLabel(panel)} collapsed.`, type: "screen.setStatus" }
            ];
        }
    };
}

function FocusableCard(props: { focused: boolean; text: string }) {
    return <Text color={props.focused ? "cyan" : undefined}>{props.text}</Text>;
}

function FocusableButton(props: { focused: boolean; label: string }) {
    return (
        <Text backgroundColor={props.focused ? "cyan" : undefined} color={props.focused ? "black" : undefined}>
            {`[ ${props.label} ]`}
        </Text>
    );
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
