import React from "react";
import { Box } from "ink";

const MAIN_WIDTH_RATIO = 0.8;
const MAIN_FRAME_WIDTH = 4;
const SIDEBAR_WIDTH_PERCENT = `${(1 - MAIN_WIDTH_RATIO) * 100}%`;
const MAIN_WIDTH_PERCENT = `${MAIN_WIDTH_RATIO * 100}%`;

export interface TuiRootLayoutProps {
    columns: number;
    footer: React.ReactNode;
    header: React.ReactNode;
    main: React.ReactNode;
    rows: number;
    sidebar: React.ReactNode;
}

export function mainInnerWidth(columns: number): number {
    return Math.max(0, Math.floor(columns * MAIN_WIDTH_RATIO) - MAIN_FRAME_WIDTH);
}

export function TuiRootLayout(props: TuiRootLayoutProps) {
    return (
        <Box flexDirection="column" height={props.rows} width={props.columns}>
            {props.header}
            <Box flexGrow={1} height={Math.max(0, props.rows - 6)}>
                <Box width={SIDEBAR_WIDTH_PERCENT}>
                    {props.sidebar}
                </Box>
                <Box borderStyle="single" flexDirection="column" flexGrow={1} paddingX={1} width={MAIN_WIDTH_PERCENT}>
                    {props.main}
                </Box>
            </Box>
            {props.footer}
        </Box>
    );
}
