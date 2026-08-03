import stringWidth from "string-width";

import type { TuiBoxLineTone, TuiBoxModel } from "../../state/TuiViewModel.js";
import type { TuiExpandableBoxStatus } from "../../state/TuiUiState.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type { TuiBoxLine as BoxLine, TuiBoxLineTone as BoxLineTone, TuiBoxModel as BoxModel } from "../../state/TuiViewModel.js";

export interface TuiComponentExpandableBoxRenderLine {
    backgroundColor?: string;
    color?: string;
    dimColor?: boolean;
    key: string;
    segments?: Array<{ text: string; underline?: boolean }>;
    text: string;
}

export function renderExpandableBoxLines(box: TuiBoxModel, requestedInnerWidth: number): TuiComponentExpandableBoxRenderLine[] {
    const innerWidth = Math.max(24, requestedInnerWidth);
    const bodyLines = box.expanded ? box.expandedLines : box.collapsedLines;
    const frame = box.focused
        ? { bottomLeft: "╰", bottomRight: "╯", horizontal: "─", topLeft: "╭", topRight: "╮" }
        : { bottomLeft: "└", bottomRight: "┘", horizontal: "─", topLeft: "┌", topRight: "┐" };
    const borderColor = box.disabled ? "gray" : lineColor(box.severity) ?? statusColor(box.status);
    const titleLine = renderTopBorder(`${interactionMarker(box)} ${box.title} [${statusMarker(box.status)} ${box.status}]`, innerWidth, frame);
    const bottomBorder = `${frame.bottomLeft}${frame.horizontal.repeat(innerWidth + 2)}${frame.bottomRight}`;

    return [
        {
            backgroundColor: box.focused ? "magenta" : undefined,
            color: box.focused ? "white" : borderColor,
            key: `${box.id}-top`,
            text: titleLine
        },
        ...bodyLines.flatMap((line, index) => {
            const selected = box.expanded && box.focused && box.selectedDetailLineId === line.id;

            if (line.editableValue !== undefined) {
                const rendered = renderEditableBodyLine(line, innerWidth);
                return [{
                    backgroundColor: selected ? "cyan" : box.focused ? "magenta" : undefined,
                    color: selected ? "black" : box.focused ? "white" : lineColor(line.tone),
                    dimColor: !selected && !box.focused && (line.tone === "muted" || line.disabled === true),
                    key: `${box.id}-${line.id ?? index}-0`,
                    segments: rendered.segments,
                    text: rendered.text,
                }];
            }

            return wrapTerminalText(line.text, innerWidth).map((wrapped, wrappedIndex) => ({
                backgroundColor: selected ? "cyan" : box.focused ? "magenta" : undefined,
                color: selected ? "black" : box.focused ? "white" : lineColor(line.tone),
                dimColor: !selected && !box.focused && (line.tone === "muted" || line.disabled === true),
                key: `${box.id}-${line.id ?? index}-${wrappedIndex}`,
                text: renderBodyLine(wrapped, innerWidth),
            }));
        }),
        {
            backgroundColor: box.focused ? "magenta" : undefined,
            color: box.focused ? "white" : borderColor,
            key: `${box.id}-bottom`,
            text: bottomBorder
        }
    ];
}

export function measureExpandableBoxHeight(box: TuiBoxModel, requestedInnerWidth = 80): number {
    const innerWidth = Math.max(24, requestedInnerWidth);
    const bodyLines = box.expanded ? box.expandedLines : box.collapsedLines;
    return bodyLines.reduce(
        (height, line) => height + (line.editableValue === undefined ? wrapTerminalText(line.text, innerWidth).length : 1),
        2,
    );
}

function renderEditableBodyLine(
    line: TuiBoxModel["expandedLines"][number],
    innerWidth: number,
): { segments: Array<{ text: string; underline?: boolean }>; text: string } {
    const editable = line.editableValue!;
    const value = editable.value;
    const valueSegments = line.editing === true
        ? editCursorSegments(value, line.cursor ?? value.length, line.cursorVisible === true)
        : [{ text: value.length === 0 ? editable.emptyPlaceholder ?? "<empty>" : value, underline: true }];
    const content = fitStyledSegments(
        [
            { text: editable.prefix },
            ...valueSegments,
            { text: editable.suffix ?? "" },
        ],
        innerWidth,
    );
    const segments = [{ text: "│ " }, ...content, { text: " │" }];
    return { segments, text: segments.map((segment) => segment.text).join("") };
}

function editCursorSegments(
    value: string,
    requestedCursor: number,
    visible: boolean,
): Array<{ text: string; underline?: boolean }> {
    const cursor = Math.min(Math.max(0, requestedCursor), value.length);
    return [
        { text: value.slice(0, cursor) },
        { text: value[cursor] ?? " ", underline: visible || undefined },
        { text: value.slice(cursor + (cursor < value.length ? 1 : 0)) },
    ];
}

function fitStyledSegments(
    segments: Array<{ text: string; underline?: boolean }>,
    width: number,
): Array<{ text: string; underline?: boolean }> {
    const output: Array<{ text: string; underline?: boolean }> = [];
    let used = 0;
    for (const segment of segments) {
        let text = "";
        for (const item of graphemeSegmenter.segment(segment.text)) {
            const nextWidth = stringWidth(item.segment);
            if (used + nextWidth > width) break;
            text += item.segment;
            used += nextWidth;
        }
        if (text.length > 0) output.push({ text, underline: segment.underline });
        if (used >= width) break;
    }
    if (used < width) output.push({ text: " ".repeat(width - used) });
    return output;
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

function lineColor(tone: TuiBoxLineTone | undefined): string | undefined {
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

function interactionMarker(box: TuiBoxModel): string {
    if (box.disabled === true) return "−";
    if (box.status === "failed" || box.severity === "danger") return "!";
    if (box.enterable) return "▸";
    return "·";
}

function statusColor(status: TuiExpandableBoxStatus): string {
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

function statusMarker(status: TuiExpandableBoxStatus): string {
    switch (status) {
        case "ready":
            return "✓";
        case "running":
            return "●";
        case "pending":
            return "…";
        case "warning":
            return "!";
        case "failed":
            return "×";
        case "disabled":
            return "−";
        case "normal":
            return "·";
    }
}
