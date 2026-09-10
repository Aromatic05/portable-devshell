import { Box, Text } from "ink";

import type { TuiSidebarModel } from "../../state/TuiViewModel.js";
import {
    selectTuiSidebarViewport,
    tuiSidebarSectionRows,
} from "../TuiSidebarPresentation.js";

export interface TuiComponentSidebarProps {
    compact?: boolean;
    model: TuiSidebarModel;
    rows: number;
}

export function TuiComponentSidebar(props: TuiComponentSidebarProps) {
    if (props.compact === true) {
        return (
            <Box flexDirection="column" height={2} overflow="hidden" width="100%">
                <CompactSidebarLine items={props.model.context.items} kind="context" />
                <CompactSidebarLine items={props.model.instances} kind="instance" />
            </Box>
        );
    }

    const sectionRows = tuiSidebarSectionRows(props.rows);

    return (
        <Box borderStyle="single" flexDirection="column" height={props.rows} paddingX={1} width="100%">
            <SidebarViewport
                items={props.model.context.items}
                kind="context"
                rows={sectionRows.contextRows}
            />
            <Box
                borderBottom={false}
                borderLeft={false}
                borderRight={false}
                borderStyle="single"
                borderTop
                height={1}
                width="100%"
            />
            <SidebarViewport
                items={props.model.instances}
                kind="instance"
                rows={sectionRows.instanceRows}
            />
        </Box>
    );
}

function compactContextLabel(item: TuiSidebarModel["context"]["items"][number]): string {
    const label = item.id === "overview" ? "over" : item.id === "instances" ? "inst" : item.id === "connections" ? "conn" : item.label;
    return `${item.selected ? "▶" : " "}${item.shortcut === undefined ? "" : `${item.shortcut}:`}${label}`;
}

function compactInstanceLabel(item: TuiSidebarModel["instances"][number], index: number): string {
    return `${item.selected ? "▶" : " "}S${index + 1}:${item.label}`;
}

function SidebarViewport(props: {
    items: TuiSidebarModel["context"]["items"] | TuiSidebarModel["instances"];
    kind: "context" | "instance";
    rows: number;
}) {
    const viewport = selectTuiSidebarViewport(props.items, props.rows);
    return (
        <Box flexDirection="column" height={props.rows} overflow="hidden" width="100%">
            {viewport.items.map((item, visibleIndex) => {
                const index = viewport.startIndex + visibleIndex;
                const shortcut = props.kind === "context"
                    ? (item as TuiSidebarModel["context"]["items"][number]).shortcut
                    : index < 9 ? `⇧${index + 1}` : undefined;
                return (
                    <Text
                        bold={item.selected}
                        inverse={item.focused}
                        key={`${item.id}-${index}`}
                        wrap="truncate-end"
                    >
                        {`${item.selected ? "▶" : " "}${shortcut === undefined ? "" : `${shortcut} `}${item.label}`}
                    </Text>
                );
            })}
        </Box>
    );
}

function CompactSidebarLine(props: { items: TuiSidebarModel["context"]["items"] | TuiSidebarModel["instances"]; kind: "context" | "instance" }) {
    return (
        <Text>
            {props.items.map((item, index) => (
                <Text bold={item.selected} inverse={item.focused} key={item.id}>
                    {`${props.kind === "context" ? compactContextLabel(item as TuiSidebarModel["context"]["items"][number]) : compactInstanceLabel(item as TuiSidebarModel["instances"][number], index)} `}
                </Text>
            ))}
        </Text>
    );
}
