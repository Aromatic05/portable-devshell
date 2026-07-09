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
    innerWidth: number;
}

export function ExpandableBox(props: ExpandableBoxProps) {
    return (
        <Box flexDirection="column">
            {renderExpandableBoxLines(props.box, props.innerWidth).map((line) => (
                <Text color={line.color} dimColor={line.dimColor} key={line.key}>
                    {line.text}
                </Text>
            ))}
        </Box>
    );
}

export interface ExpandableBoxRenderLine {
    color?: string;
    dimColor?: boolean;
    key: string;
    text: string;
}

export function renderExpandableBoxLines(box: BoxModel, requestedInnerWidth: number): ExpandableBoxRenderLine[] {
    const innerWidth = Math.max(24, requestedInnerWidth);
    const bodyLines = box.expanded ? box.expandedLines : box.collapsedLines;
    const frame = box.focused
        ? { bottomLeft: "╰", bottomRight: "╯", horizontal: "─", topLeft: "╭", topRight: "╮" }
        : { bottomLeft: "└", bottomRight: "┘", horizontal: "─", topLeft: "┌", topRight: "┐" };
    const borderColor = box.focused ? "cyan" : box.disabled ? "gray" : "white";
    const titleLine = renderTopBorder(`${box.title} · ${box.status}`, innerWidth, frame);
    const bottomBorder = `${frame.bottomLeft}${frame.horizontal.repeat(innerWidth + 2)}${frame.bottomRight}`;

    return [
        {
            color: borderColor,
            key: `${box.id}-top`,
            text: titleLine
        },
        ...bodyLines.map((line, index) => ({
            color: lineColor(line.tone),
            dimColor: line.tone === "muted",
            key: `${box.id}-${index}`,
            text: renderBodyLine(line.text, innerWidth)
        })),
        {
            color: borderColor,
            key: `${box.id}-bottom`,
            text: bottomBorder
        }
    ];
}

function renderTopBorder(title: string, innerWidth: number, frame: { horizontal: string; topLeft: string; topRight: string }): string {
    const maxTitleWidth = Math.max(1, innerWidth - 1);
    const normalizedTitle = truncateTitle(title, maxTitleWidth);
    const suffixWidth = Math.max(0, innerWidth - normalizedTitle.length - 1);
    return `${frame.topLeft}${frame.horizontal} ${normalizedTitle}${suffixWidth > 0 ? ` ${frame.horizontal.repeat(suffixWidth)}` : ""}${frame.topRight}`;
}

function renderBodyLine(text: string, innerWidth: number): string {
    const normalized = padRight(truncateTitle(text, innerWidth), innerWidth);
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
