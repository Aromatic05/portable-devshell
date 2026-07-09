import React from "react";
import { Box, Text } from "ink";

import type { ExpandableBoxStatus } from "../model/TuiUiTypes.js";

export interface ExpandableBoxProps {
    id: string;
    title: string;
    status?: ExpandableBoxStatus;
    focused: boolean;
    expanded: boolean;
    disabled?: boolean;
    summary: React.ReactNode;
    children?: React.ReactNode;
}

export function ExpandableBox(props: ExpandableBoxProps) {
    const borderColor = props.focused ? "cyan" : props.disabled ? "gray" : "white";
    const titleColor = props.focused ? "cyan" : props.disabled ? "gray" : undefined;
    const statusColor = statusColorFor(props.status, props.disabled === true);

    return (
        <Box borderColor={borderColor} borderStyle="single" flexDirection="column" paddingX={1} paddingY={0}>
            <Box justifyContent="space-between">
                <Text bold color={titleColor}>
                    {props.title}
                </Text>
                <Text color={statusColor}>{props.status ?? (props.disabled ? "disabled" : "normal")}</Text>
            </Box>
            <Box flexDirection="column">{props.summary}</Box>
            {props.expanded ? <Box flexDirection="column" marginTop={1}>{props.children}</Box> : undefined}
        </Box>
    );
}

function statusColorFor(status: ExpandableBoxStatus | undefined, disabled: boolean): string | undefined {
    if (disabled) {
        return "gray";
    }

    switch (status) {
        case "ready":
            return "green";
        case "running":
            return "cyan";
        case "warning":
            return "yellow";
        case "failed":
            return "red";
        case "disabled":
            return "gray";
        case "pending":
            return "yellow";
        case "normal":
        default:
            return undefined;
    }
}
