import { useEffect } from "react";
import { Box, Text } from "ink";

import type { TuiTextDetailState } from "../../state/TuiInteractionState.js";
import { tuiTextDetailBodyRows, tuiTextDetailImageRows } from "../TuiTextDetailLayout.js";
import { wrapTerminalText } from "./TuiComponentExpandableBox.js";

export interface TuiComponentTextDetailProps {
    detail: TuiTextDetailState;
    onImageVisibility?(visible: boolean): void;
    viewportRows: number;
    width: number;
}

export function TuiComponentTextDetail(props: TuiComponentTextDetailProps) {
    const width = Math.max(20, props.width);
    const hasImage = props.detail.image !== undefined;
    const imageRows = hasImage ? tuiTextDetailImageRows(props.viewportRows) : 0;
    const viewport = tuiTextDetailBodyRows(props.viewportRows, hasImage);
    const lines = wrapTerminalText(props.detail.body, width);
    const offset = clamp(props.detail.scrollOffset, 0, Math.max(0, lines.length - viewport));

    useEffect(() => {
        props.onImageVisibility?.(hasImage);
        return () => props.onImageVisibility?.(false);
    }, [hasImage, props.detail.image, props.onImageVisibility]);

    return (
        <Box flexDirection="column">
            <Text bold>{props.detail.title}</Text>
            {props.detail.image === undefined ? undefined : (
                <Text dimColor>{`${props.detail.image.name} · ${props.detail.image.mediaType} · ${props.detail.image.bytes} bytes · native preview`}</Text>
            )}
            {props.detail.image === undefined
                ? undefined
                : Array.from({ length: imageRows }, (_, row) => (
                    <Text key={`image:${row}`}>{" ".repeat(width)}</Text>
                ))}
            {lines.slice(offset, offset + viewport).map((line, index) => (
                <Text color={detailLineColor(line)} key={`${offset + index}:${line}`}>{line}</Text>
            ))}
            <Text dimColor>{`line ${Math.min(offset + 1, Math.max(lines.length, 1))}-${Math.min(offset + viewport, lines.length)} / ${lines.length} · Esc/Enter back`}</Text>
        </Box>
    );
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function detailLineColor(line: string): string | undefined {
    const value = line.trimStart();
    if (/^(command|path|target|cwd):/u.test(value)) {
        return "yellow";
    }
    if (value.startsWith("+++") || value.startsWith("+")) {
        return "green";
    }
    if (value.startsWith("---") || value.startsWith("-")) {
        return "red";
    }
    if (value.startsWith("@@") || value.startsWith("***")) {
        return "cyan";
    }
    return undefined;
}
