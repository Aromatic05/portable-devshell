import { Box, Text } from "ink";

import { tuiConfirmationActionText } from "../overlay/TuiOverlayPresentation.js";

export interface TuiComponentConfirmDialogProps {
    body: string;
    cancelFocused: boolean;
    cancelLabel: string;
    confirmFocused: boolean;
    confirmLabel: string;
    open: boolean;
    title: string;
    width: number;
}

export function TuiComponentConfirmDialog(props: TuiComponentConfirmDialogProps) {
    if (!props.open) {
        return null;
    }

    return (
        <Box borderStyle="double" flexDirection="column" paddingX={1} width={props.width}>
            <Text bold>{props.title}</Text>
            <Text>{props.body}</Text>
            <Box gap={1}>
                <Text backgroundColor={props.cancelFocused ? "cyan" : undefined} color={props.cancelFocused ? "black" : undefined}>
                    {tuiConfirmationActionText(props.cancelLabel)}
                </Text>
                <Text backgroundColor={props.confirmFocused ? "cyan" : undefined} color={props.confirmFocused ? "black" : undefined}>
                    {tuiConfirmationActionText(props.confirmLabel)}
                </Text>
            </Box>
        </Box>
    );
}
