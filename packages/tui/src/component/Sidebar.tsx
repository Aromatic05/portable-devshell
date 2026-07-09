import React from "react";
import { Box, Text } from "ink";

import type { SidebarModel } from "../store/TuiSelectors.js";

export interface SidebarProps {
    model: SidebarModel;
}

export function Sidebar(props: SidebarProps) {
    return (
        <Box borderStyle="single" flexDirection="column" paddingX={1} width="100%">
            <SidebarSection items={props.model.pages} />
            <Box height={1} />
            <SidebarSection items={props.model.instances} />
        </Box>
    );
}

function SidebarSection(props: { items: SidebarModel["pages"] }) {
    return (
        <Box flexDirection="column">
            {props.items.map((item, index) => (
                <Text backgroundColor={item.focused ? "cyan" : undefined} bold={item.selected} color={item.selected ? "green" : item.focused ? "black" : undefined} key={`${item.id}-${index}`}>
                    {item.label}
                </Text>
            ))}
        </Box>
    );
}
