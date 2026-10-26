import { Box, Text } from "ink";
import { wrapTerminalText } from "../../terminal/Public.js";

import { tuiConfirmationActionText, tuiOverlayBodyLayout } from "../../layout/Overlay.js";

export interface TuiComponentConfirmDialogProps {
    body: string;
    scrollOffset?: number;
    viewportRows?: number;
    cancelFocused: boolean;
    cancelLabel: string;
    confirmFocused: boolean;
    confirmLabel: string;
    open: boolean;
    title: string;
    width: number;
}

export function TuiComponentConfirmDialog(
    props: TuiComponentConfirmDialogProps,
) {
    if (!props.open) {
        return null;
    }

    const layout = tuiOverlayBodyLayout(props.body, props.width, props.viewportRows, props.scrollOffset,
        wrapTerminalText(props.title, Math.max(1, props.width - 4)).length);
    return (
        <Box
            borderStyle="double"
            flexDirection="column"
            paddingX={1}
            width={props.width}
        >
            <Text bold>{props.title}</Text>
            <Box flexDirection="column" height={layout.rows} flexShrink={0}>
                {layout.lines.map((line, index) => <Text key={index}>{line}</Text>)}
            </Box>
            <Text dimColor>{`PgUp/PgDn scroll · ${layout.offset + 1}-${layout.offset + layout.rows}/${layout.total}`}</Text>
            <Box gap={1} flexShrink={0}>
                <Text
                    backgroundColor={props.cancelFocused ? "cyan" : undefined}
                    color={props.cancelFocused ? "black" : undefined}
                >
                    {tuiConfirmationActionText(props.cancelLabel)}
                </Text>
                <Text
                    backgroundColor={props.confirmFocused ? "cyan" : undefined}
                    color={props.confirmFocused ? "black" : undefined}
                >
                    {tuiConfirmationActionText(props.confirmLabel)}
                </Text>
            </Box>
        </Box>
    );
}
