import { Box, Text } from "ink";

export interface TuiComponentFooterProps {
    text: string;
}

export function TuiComponentFooter(props: TuiComponentFooterProps) {
    return (
        <Box borderStyle="single" height={3} paddingX={1}>
            <Text>{props.text}</Text>
        </Box>
    );
}
