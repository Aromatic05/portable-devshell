import { Box, Text } from "ink";

export interface TuiComponentHeaderProps {
    stateLabel: string;
    summary: string;
    title: string;
}

export function TuiComponentHeader(props: TuiComponentHeaderProps) {
    return (
        <Box borderStyle="single" flexDirection="column" height={3} paddingX={1}>
            <Text bold>{props.title}</Text>
            <Text>{`${props.summary} | ${props.stateLabel}`}</Text>
        </Box>
    );
}
