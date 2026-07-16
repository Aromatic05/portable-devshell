import { Box, Text } from "ink";

export interface ConfirmDialogProps {
    body: string;
    cancelFocused: boolean;
    cancelLabel: string;
    confirmFocused: boolean;
    confirmLabel: string;
    open: boolean;
    title: string;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
    if (!props.open) {
        return null;
    }

    return (
        <Box borderStyle="double" flexDirection="column" paddingX={1}>
            <Text bold>{props.title}</Text>
            <Text>{props.body}</Text>
            <Box gap={1}>
                <Text backgroundColor={props.cancelFocused ? "cyan" : undefined} color={props.cancelFocused ? "black" : undefined}>
                    {`[ ${props.cancelLabel} ]`}
                </Text>
                <Text backgroundColor={props.confirmFocused ? "cyan" : undefined} color={props.confirmFocused ? "black" : undefined}>
                    {`[ ${props.confirmLabel} ]`}
                </Text>
            </Box>
        </Box>
    );
}
