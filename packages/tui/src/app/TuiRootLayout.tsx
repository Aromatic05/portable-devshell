import React from "react";
import { Box } from "ink";

export interface TuiRootLayoutProps {
    footer: React.ReactNode;
    header: React.ReactNode;
    main: React.ReactNode;
    sidebar: React.ReactNode;
}

export function TuiRootLayout(props: TuiRootLayoutProps) {
    return (
        <Box flexDirection="column" height="100%">
            {props.header}
            <Box flexGrow={1}>
                {props.sidebar}
                <Box borderStyle="single" flexDirection="column" flexGrow={1} paddingX={1}>
                    {props.main}
                </Box>
            </Box>
            {props.footer}
        </Box>
    );
}
