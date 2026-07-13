import React from "react";
import { Box, Text } from "ink";

const GAP = 1;
const SIDEBAR_WIDTH_RATIO = 0.15;
const MAIN_PANEL_WIDTH_RATIO = 0.85;
const COMPACT_LAYOUT_MAX_COLUMNS = 89;
export const MINIMUM_TERMINAL_COLUMNS = 60;
export const MINIMUM_TERMINAL_ROWS = 14;

export interface TuiRootLayoutProps {
    columns: number;
    footer: React.ReactNode;
    header: React.ReactNode;
    main: React.ReactNode;
    rows: number;
    sidebar: React.ReactNode;
}

export function mainInnerWidth(columns: number): number {
    const layout = tuiLayoutMetrics(columns);
    return layout.mode === "compact" ? Math.max(0, columns - 4) : Math.max(0, layout.mainPanelWidth - GAP * 8);
}

export function TuiRootLayout(props: TuiRootLayoutProps) {
    const layout = tuiLayoutMetrics(props.columns);

    if (!isTerminalSizeSupported(props.columns, props.rows)) {
        return (
            <Box alignItems="center" height={props.rows} justifyContent="center" width={props.columns}>
                <Text color="yellow">{`Terminal too small (need ${MINIMUM_TERMINAL_COLUMNS}x${MINIMUM_TERMINAL_ROWS})`}</Text>
            </Box>
        );
    }

    if (layout.mode === "compact") {
        return (
            <Box flexDirection="column" height={props.rows} width={props.columns}>
                {props.header}
                <Box flexDirection="column" flexGrow={1} height={Math.max(0, props.rows - 6)}>
                    <Box height={2} width={props.columns}>
                        {props.sidebar}
                    </Box>
                    <Box borderStyle="single" flexDirection="column" flexGrow={1} paddingX={1} width={props.columns}>
                        {props.main}
                    </Box>
                </Box>
                {props.footer}
            </Box>
        );
    }

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

export function tuiLayoutMetrics(columns: number): {
    mainPanelWidth: number;
    mode: "compact" | "full";
    outerGap: number;
    panelGap: number;
    sidebarWidth: number;
} {
    if (columns <= COMPACT_LAYOUT_MAX_COLUMNS) {
        return {
            mainPanelWidth: Math.max(0, columns),
            mode: "compact",
            outerGap: 0,
            panelGap: 0,
            sidebarWidth: 0
        };
    }

    const totalGap = GAP * 3;
    const usableWidth = Math.max(0, columns - totalGap);

    return {
        mainPanelWidth: Math.max(0, Math.floor(usableWidth * MAIN_PANEL_WIDTH_RATIO)),
        mode: "full",
        outerGap: GAP,
        panelGap: GAP,
        sidebarWidth: Math.max(0, Math.floor(usableWidth * SIDEBAR_WIDTH_RATIO))
    };
}

export function isTerminalSizeSupported(columns: number, rows: number): boolean {
    return columns >= MINIMUM_TERMINAL_COLUMNS && rows >= MINIMUM_TERMINAL_ROWS;
}
