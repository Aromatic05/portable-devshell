import { Box, Text } from "ink";

export interface ErrorBannerProps {
    lines: string[];
}

export function ErrorBanner(props: ErrorBannerProps) {
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
