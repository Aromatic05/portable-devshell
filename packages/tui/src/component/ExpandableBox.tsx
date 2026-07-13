import React from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";

import type { ExpandableBoxStatus } from "../model/TuiUiTypes.js";

export type BoxLineTone = "normal" | "muted" | "accent" | "success" | "warning" | "danger";

export interface BoxLine {
    disabled?: boolean;
    id?: string;
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
    expandedKey: string;
    severity?: BoxLineTone;
    selectedDetailLineId?: string;
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
                <Text backgroundColor={line.backgroundColor} color={line.color} dimColor={line.dimColor} key={line.key}>
                    {line.text}
                </Text>
            ))}
        </Box>
    );
}

export interface ExpandableBoxRenderLine {
    backgroundColor?: string;
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
    const borderColor = box.disabled ? "gray" : lineColor(box.severity) ?? statusColor(box.status);
    const titleLine = renderTopBorder(`${box.title} · ${box.status}`, innerWidth, frame);
    const bottomBorder = `${frame.bottomLeft}${frame.horizontal.repeat(innerWidth + 2)}${frame.bottomRight}`;

    return [
        {
            color: borderColor,
            key: `${box.id}-top`,
            text: titleLine
        },
        ...bodyLines.flatMap((line, index) => {
            const selected = box.expanded && box.focused && box.selectedDetailLineId === line.id;

            return wrapTerminalText(line.text, innerWidth).map((wrapped, wrappedIndex) => ({
                backgroundColor: selected ? "cyan" : undefined,
                color: selected ? "black" : lineColor(line.tone),
                dimColor: !selected && (line.tone === "muted" || line.disabled === true),
                key: `${box.id}-${line.id ?? index}-${wrappedIndex}`,
                text: renderBodyLine(wrapped, innerWidth)
            }));
        }),
        {
            color: borderColor,
            key: `${box.id}-bottom`,
            text: bottomBorder
        }
    ];
}

export function measureExpandableBoxHeight(box: BoxModel, requestedInnerWidth = 80): number {
    const innerWidth = Math.max(24, requestedInnerWidth);
    const bodyLines = box.expanded ? box.expandedLines : box.collapsedLines;
    return bodyLines.reduce((height, line) => height + wrapTerminalText(line.text, innerWidth).length, 2);
}

function renderTopBorder(title: string, innerWidth: number, frame: { horizontal: string; topLeft: string; topRight: string }): string {
    const maxTitleWidth = Math.max(1, innerWidth - 1);
    const normalizedTitle = truncateTitle(title, maxTitleWidth);
    const suffixWidth = Math.max(0, innerWidth - stringWidth(normalizedTitle) - 1);
    return `${frame.topLeft}${frame.horizontal} ${normalizedTitle}${suffixWidth > 0 ? ` ${frame.horizontal.repeat(suffixWidth)}` : ""}${frame.topRight}`;
}

function renderBodyLine(text: string, innerWidth: number): string {
    const normalized = padRight(truncateTerminalText(text, innerWidth), innerWidth);
    return `│ ${normalized} │`;
}

function padRight(text: string, width: number): string {
    const textWidth = stringWidth(text);
    if (textWidth >= width) {
        return text;
    }

    return `${text}${" ".repeat(width - textWidth)}`;
}

function truncateTitle(text: string, width: number): string {
    return truncateTerminalText(text, width);
}

function truncateTerminalText(text: string, width: number): string {
    if (stringWidth(text) <= width) {
        return text;
    }

    if (width <= 1) {
        return "…";
    }

    return `${takeTerminalWidth(text, width - 1)}…`;
}

export function wrapTerminalText(text: string, width: number): string[] {
    const safeWidth = Math.max(1, width);
    const output: string[] = [];

    for (const sourceLine of text.split(/\r?\n/u)) {
        if (sourceLine.length === 0) {
            output.push("");
            continue;
        }

        let current = "";
        for (const token of sourceLine.match(/\s+|\S+/gu) ?? []) {
            if (stringWidth(current + token) <= safeWidth) {
                current += token;
                continue;
            }

            if (current.length > 0) {
                output.push(current.trimEnd());
                current = token.trimStart();
            } else {
                current = token;
            }

            while (stringWidth(current) > safeWidth) {
                const chunk = takeTerminalWidth(current, safeWidth);
                output.push(chunk);
                current = current.slice(chunk.length);
            }
        }

        output.push(current.trimEnd());
    }

    return output;
}

function takeTerminalWidth(text: string, width: number): string {
    let output = "";
    for (const segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
        if (stringWidth(output + segment.segment) > width) {
            break;
        }
        output += segment.segment;
    }
    return output.length === 0 ? text.slice(0, 1) : output;
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

function statusColor(status: ExpandableBoxStatus): string {
    switch (status) {
        case "ready":
            return "green";
        case "running":
            return "cyan";
        case "pending":
        case "warning":
            return "yellow";
        case "failed":
            return "red";
        case "disabled":
            return "gray";
        case "normal":
            return "white";
    }
}
