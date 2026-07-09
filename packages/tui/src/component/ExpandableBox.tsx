import React from "react";
import { Box, Text } from "ink";

import type { ExpandableBoxStatus } from "../model/TuiUiTypes.js";

export const EXPANDABLE_BOX_INNER_WIDTH = 58;

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
    const bodyLines = props.box.expanded ? props.box.expandedLines : props.box.collapsedLines;
    const frame = props.box.focused
        ? { bottomLeft: "╰", bottomRight: "╯", horizontal: "─", topLeft: "╭", topRight: "╮" }
        : { bottomLeft: "└", bottomRight: "┘", horizontal: "─", topLeft: "┌", topRight: "┐" };
    const borderColor = props.box.focused ? "cyan" : props.box.disabled ? "gray" : "white";
    const titleColor = props.box.disabled ? "gray" : undefined;
    const title = `${props.box.title} · ${props.box.status}`;
    const titleLine = renderTopBorder(title, frame);
    const bottomBorder = `${frame.bottomLeft}${frame.horizontal.repeat(EXPANDABLE_BOX_INNER_WIDTH + 2)}${frame.bottomRight}`;

    return (
        <Box flexDirection="column">
            <Text color={borderColor}>
                <Text color={titleColor}>{titleLine.prefix}</Text>
                <Text bold color={titleColor}>
                    {titleLine.title}
                </Text>
                <Text color={titleColor}>{titleLine.suffix}</Text>
            </Text>
            {bodyLines.map((line, index) => (
                <Text color={lineColor(line.tone)} dimColor={line.tone === "muted"} key={`${props.box.id}-${index}`}>
                    {renderBodyLine(line.text)}
                </Text>
            ))}
            <Text color={borderColor}>{bottomBorder}</Text>
        </Box>
    );
}

function renderTopBorder(title: string, frame: { horizontal: string; topLeft: string; topRight: string }): { prefix: string; suffix: string; title: string } {
    const normalizedTitle = truncateTitle(title, EXPANDABLE_BOX_INNER_WIDTH);
    const prefix = `${frame.topLeft}${frame.horizontal} `;
    const suffixWidth = Math.max(0, EXPANDABLE_BOX_INNER_WIDTH - normalizedTitle.length);
    const suffix = ` ${frame.horizontal.repeat(suffixWidth)}${frame.topRight}`;

    return {
        prefix,
        suffix,
        title: normalizedTitle
    };
}

function renderBodyLine(text: string): string {
    const normalized = padRight(truncateTitle(text, EXPANDABLE_BOX_INNER_WIDTH), EXPANDABLE_BOX_INNER_WIDTH);
    return `│ ${normalized} │`;
}

function padRight(text: string, width: number): string {
    if (text.length >= width) {
        return text;
    }

    return `${text}${" ".repeat(width - text.length)}`;
}

function truncateTitle(text: string, width: number): string {
    if (text.length <= width) {
        return text;
    }

    if (width <= 1) {
        return "…";
    }

    return `${text.slice(0, width - 1)}…`;
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
