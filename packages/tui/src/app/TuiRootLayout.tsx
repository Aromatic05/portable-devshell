import React from "react";
import { Box } from "ink";

export interface TuiRootLayoutProps {
    columns: number;
    footer: React.ReactNode;
    header: React.ReactNode;
    main: React.ReactNode;
    rows: number;
    sidebar: React.ReactNode;
}

export function TuiRootLayout(props: TuiRootLayoutProps) {
    return (
        <Box flexDirection="column" height={props.rows} width={props.columns}>
            {props.header}
            <Box flexGrow={1} height={Math.max(0, props.rows - 6)}>
                {props.sidebar}
                <Box borderStyle="single" flexDirection="column" flexGrow={1} paddingX={1} width={Math.max(0, props.columns - 22)}>
                    {props.main}
                </Box>
            </Box>
            {props.footer}
        </Box>
    );
}
