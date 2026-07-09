import React from "react";
import { Box, Text } from "ink";

import type { ExpandableBoxStatus } from "../model/TuiUiTypes.js";

export type BoxLineTone = "normal" | "muted" | "accent" | "success" | "warning" | "danger";

export interface BoxLine {
    text: string;
    tone?: BoxLineTone;
}

export interface BoxModel {
    collapsedLines: readonly [BoxLine] | readonly [BoxLine, BoxLine];
    disabled?: boolean;
    expanded: boolean;
    expandedLines: readonly BoxLine[];
    focused: boolean;
    id: string;
    status: ExpandableBoxStatus;
    title: string;
}

export interface ExpandableBoxProps {
    box: BoxModel;
}

export function ExpandableBox(props: ExpandableBoxProps) {
    const borderColor = props.box.focused ? "cyan" : props.box.disabled ? "gray" : "white";
    const titleColor = props.box.focused ? "cyan" : props.box.disabled ? "gray" : undefined;

    return (
        <Box borderColor={borderColor} borderStyle="single" flexDirection="column" paddingX={1} width="100%">
            <Box justifyContent="space-between">
                <Text bold color={titleColor}>
                    {props.box.title}
                </Text>
                <Text color={statusColor(props.box.status, props.box.disabled === true)}>{props.box.status}</Text>
            </Box>
            {(props.box.expanded ? props.box.expandedLines : props.box.collapsedLines).map((line, index) => (
                <Text color={lineColor(line.tone)} dimColor={line.tone === "muted"} key={`${props.box.id}-${index}`}>
                    {line.text}
                </Text>
            ))}
        </Box>
    );
}

function lineColor(tone: BoxLineTone | undefined): string | undefined {
    switch (tone) {
        case "accent":
            return "cyan";
        case "success":
            return "green";
        case "warning":
            return "yellow";
        case "danger":
            return "red";
        default:
            return undefined;
    }
}

function statusColor(status: ExpandableBoxStatus, disabled: boolean): string | undefined {
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
