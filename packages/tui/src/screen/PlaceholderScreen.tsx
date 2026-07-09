import React from "react";
import { Box, Text } from "ink";

export interface PlaceholderScreenProps {
    lines: string[];
    title: string;
}

export function PlaceholderScreen(props: PlaceholderScreenProps) {
    return (
        <Box flexDirection="column" gap={1}>
            <Text bold>{props.title}</Text>
            <Box flexDirection="column">
                {props.lines.map((line, index) => (
                    <Text key={`${props.title}-${index}`}>{line}</Text>
                ))}
            </Box>
        </Box>
    );
}
