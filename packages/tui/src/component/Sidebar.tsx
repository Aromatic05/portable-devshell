import React from "react";
import { Box, Text } from "ink";

import type { TuiPanel } from "../store/TuiReducers.js";

export interface SidebarProps {
    items: Array<{ active: boolean; label: string; panel: TuiPanel }>;
}

export function Sidebar(props: SidebarProps) {
    return (
        <Box borderStyle="single" flexDirection="column" paddingX={1} width={22}>
            {props.items.map((item, index) => (
                <Text bold={item.active} color={item.active ? "cyan" : undefined} key={item.panel}>
                    {`${index + 1}. ${item.label}`}
                </Text>
            ))}
        </Box>
    );
}
