import React from "react";
import { Box, Text } from "ink";

export interface ActionMenuProps {
    items: Array<{ active: boolean; id: string; label: string }>;
    open: boolean;
    title: string;
}

export function ActionMenu(props: ActionMenuProps) {
    if (!props.open) {
        return null;
    }

    return (
        <Box borderStyle="round" flexDirection="column" paddingX={1}>
            <Text bold>{props.title}</Text>
            {props.items.map((item) => (
                <Text backgroundColor={item.active ? "cyan" : undefined} color={item.active ? "black" : undefined} key={item.id}>
                    {item.label}
                </Text>
            ))}
        </Box>
    );
}
