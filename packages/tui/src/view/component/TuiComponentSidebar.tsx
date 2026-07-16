import { Box, Text } from "ink";

import type { SidebarModel } from "../../state/TuiSelectors.js";

export interface TuiComponentSidebarProps {
    compact?: boolean;
    model: SidebarModel;
}

export function TuiComponentSidebar(props: TuiComponentSidebarProps) {
    if (props.compact === true) {
        return (
            <Box flexDirection="column" height={2} overflow="hidden" width="100%">
                <CompactSidebarLine items={props.model.pages} kind="page" />
                <CompactSidebarLine items={props.model.instances} kind="instance" />
            </Box>
        );
    }

    return (
        <Box borderStyle="single" flexDirection="column" paddingX={1} width="100%">
            <SidebarSection items={props.model.pages} />
            <Box height={1} />
            <SidebarSection items={props.model.instances} />
        </Box>
    );
}

function compactPageLabel(item: SidebarModel["pages"][number], index: number): string {
    const label = item.id === "instances" ? "inst" : item.id === "connector" ? "conn" : item.label;
    return `${item.selected ? "▶" : " "}${index + 1}:${label}`;
}

function compactInstanceLabel(item: SidebarModel["instances"][number], index: number): string {
    return `${item.selected ? "▶" : " "}S${index + 1}:${item.label}`;
}

function SidebarSection(props: { items: SidebarModel["pages"] }) {
    return (
        <Box flexDirection="column">
            {props.items.map((item, index) => (
                <Text bold={item.selected} inverse={item.focused} key={`${item.id}-${index}`}>
                    {`${item.selected ? "▶" : " "}${item.label}`}
                </Text>
            ))}
        </Box>
    );
}

function CompactSidebarLine(props: { items: SidebarModel["pages"] | SidebarModel["instances"]; kind: "instance" | "page" }) {
    return (
        <Text>
            {props.items.map((item, index) => (
                <Text bold={item.selected} inverse={item.focused} key={item.id}>
                    {`${props.kind === "page" ? compactPageLabel(item as SidebarModel["pages"][number], index) : compactInstanceLabel(item as SidebarModel["instances"][number], index)} `}
                </Text>
            ))}
        </Text>
    );
}
