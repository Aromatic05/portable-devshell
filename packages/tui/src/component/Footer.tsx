import React from "react";
import { Box, Text } from "ink";

export interface FooterProps {
    text: string;
}

export function Footer(props: FooterProps) {
    return (
        <Box borderStyle="single" height={3} paddingX={1}>
            <Text>{props.text}</Text>
        </Box>
    );
}
