import React from "react";
import { Box, Text } from "ink";

export interface HeaderProps {
    stateLabel: string;
    summary: string;
    title: string;
}

export function Header(props: HeaderProps) {
    return (
        <Box borderStyle="single" flexDirection="column" height={3} paddingX={1}>
            <Text bold>{props.title}</Text>
            <Text>{`${props.summary} | ${props.stateLabel}`}</Text>
        </Box>
    );
}
