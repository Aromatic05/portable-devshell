import React from "react";
import { Box } from "ink";

const GAP = 1;
const SIDEBAR_WIDTH_RATIO = 0.15;
const MAIN_PANEL_WIDTH_RATIO = 0.85;

export interface TuiRootLayoutProps {
    columns: number;
    footer: React.ReactNode;
    header: React.ReactNode;
    main: React.ReactNode;
    rows: number;
    sidebar: React.ReactNode;
}

export function mainInnerWidth(columns: number): number {
    return Math.max(0, layoutMetrics(columns).mainPanelWidth - GAP * 8);
}

export function TuiRootLayout(props: TuiRootLayoutProps) {
    const layout = layoutMetrics(props.columns);

    return (
        <Box flexDirection="column" height={props.rows} width={props.columns}>
            {props.header}
            <Box flexGrow={1} height={Math.max(0, props.rows - 6)}>
                <Box width={layout.outerGap} />
                <Box width={layout.sidebarWidth}>
                    {props.sidebar}
                </Box>
                <Box width={layout.panelGap} />
                <Box borderStyle="single" flexDirection="column" paddingX={1} width={layout.mainPanelWidth}>
                    {props.main}
                </Box>
                <Box width={layout.outerGap} />
            </Box>
            {props.footer}
        </Box>
    );
}

function layoutMetrics(columns: number): {
    mainPanelWidth: number;
    outerGap: number;
    panelGap: number;
    sidebarWidth: number;
} {
    const totalGap = GAP * 3;
    const usableWidth = Math.max(0, columns - totalGap);

    return {
        mainPanelWidth: Math.max(0, Math.floor(usableWidth * MAIN_PANEL_WIDTH_RATIO)),
        outerGap: GAP,
        panelGap: GAP,
        sidebarWidth: Math.max(0, Math.floor(usableWidth * SIDEBAR_WIDTH_RATIO))
    };
}
