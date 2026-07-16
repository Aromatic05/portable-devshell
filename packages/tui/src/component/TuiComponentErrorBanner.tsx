import { Box, Text } from "ink";

export interface TuiComponentErrorBannerProps {
    lines: string[];
}

export function TuiComponentErrorBanner(props: TuiComponentErrorBannerProps) {
    return (
        <Box borderStyle="round" borderColor="red" flexDirection="column" paddingX={1}>
            {props.lines.map((line, index) => (
                <Text color="red" key={index}>
                    {line}
                </Text>
            ))}
        </Box>
    );
}
