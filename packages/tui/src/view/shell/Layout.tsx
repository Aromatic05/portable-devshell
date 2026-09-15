import React from "react";
import { Box, Text } from "ink";

const GAP = 1;
const SIDEBAR_WIDTH_RATIO = 0.15;
const MAIN_PANEL_WIDTH_RATIO = 0.85;
const COMPACT_LAYOUT_MAX_COLUMNS = 89;
export const MINIMUM_TERMINAL_COLUMNS = 60;
export const MINIMUM_TERMINAL_ROWS = 14;

export function tuiRenderRows(rows: number): number {
    return Math.max(1, Math.floor(rows) - 1);
}

export interface TuiRootLayoutProps {
    columns: number;
    footer: React.ReactNode;
    header: React.ReactNode;
    main: React.ReactNode;
    rows: number;
    sidebar?: React.ReactNode;
}

export function mainContentWidth(columns: number, fullWidth = false): number {
    if (fullWidth) return Math.max(0, columns - 4);
    const layout = tuiLayoutMetrics(columns);
    return layout.mode === "compact"
        ? Math.max(0, columns - 4)
        : Math.max(0, layout.mainPanelWidth - 4);
}

export function mainBoxInnerWidth(columns: number, fullWidth = false): number {
    return Math.max(0, mainContentWidth(columns, fullWidth) - 4);
}

export function tuiBlockHeight(lines: readonly string[] | undefined): number {
    return lines === undefined ? 0 : lines.length + 2;
}

export function tuiMainLayoutMetrics(
    columns: number,
    rows: number,
    sidebarVisible = true,
): {
    boxInnerWidth: number;
    contentHeight: number;
    contentWidth: number;
    contentX: number;
    contentY: number;
    layout: ReturnType<typeof tuiLayoutMetrics>;
    renderRows: number;
} {
    const layout = tuiLayoutMetrics(columns);
    const renderRows = tuiRenderRows(rows);
    const compactSidebarRows =
        sidebarVisible && layout.mode === "compact" ? 2 : 0;
    const panelWidth =
        sidebarVisible && layout.mode === "full"
            ? layout.mainPanelWidth
            : Math.max(0, columns);
    const panelOuterX =
        sidebarVisible && layout.mode === "full"
            ? layout.outerGap + layout.sidebarWidth + layout.panelGap + 1
            : 1;
    const panelOuterY = 4 + compactSidebarRows;
    const contentWidth = Math.max(0, panelWidth - 4);
    return {
        boxInnerWidth: Math.max(0, contentWidth - 4),
        contentHeight: Math.max(0, renderRows - 6 - compactSidebarRows - 2),
        contentWidth,
        contentX: panelOuterX + 2,
        contentY: panelOuterY + 1,
        layout,
        renderRows,
    };
}

export function TuiRootLayout(props: TuiRootLayoutProps) {
    const layout = tuiLayoutMetrics(props.columns);
    const renderRows = tuiRenderRows(props.rows);

    if (!isTerminalSizeSupported(props.columns, props.rows)) {
        return (
            <Box alignItems="center" height={renderRows} justifyContent="center" width={props.columns}>
                <Text color="yellow">{`Terminal too small (need ${MINIMUM_TERMINAL_COLUMNS}x${MINIMUM_TERMINAL_ROWS})`}</Text>
            </Box>
        );
    }

    if (props.sidebar === undefined) {
        return (
            <Box flexDirection="column" height={renderRows} width={props.columns}>
                {props.header}
                <Box flexGrow={1} height={Math.max(0, renderRows - 6)}>
                    <Box
                        borderStyle="single"
                        flexDirection="column"
                        flexGrow={1}
                        paddingX={1}
                        width={props.columns}
                    >
                        {props.main}
                    </Box>
                </Box>
                {props.footer}
            </Box>
        );
    }

    if (layout.mode === "compact") {
        return (
            <Box flexDirection="column" height={renderRows} width={props.columns}>
                {props.header}
                <Box flexDirection="column" flexGrow={1} height={Math.max(0, renderRows - 6)}>
                    <Box height={2} width={props.columns}>
                        {props.sidebar}
                    </Box>
                    <Box
                        borderStyle="single"
                        flexDirection="column"
                        flexGrow={1}
                        paddingX={1}
                        width={props.columns}
                    >
                        {props.main}
                    </Box>
                </Box>
                {props.footer}
            </Box>
        );
    }

    return (
        <Box flexDirection="column" height={renderRows} width={props.columns}>
            {props.header}
            <Box flexGrow={1} height={Math.max(0, renderRows - 6)}>
                <Box width={layout.outerGap} />
                <Box width={layout.sidebarWidth}>
                    {props.sidebar}
                </Box>
                <Box width={layout.panelGap} />
                <Box
                    borderStyle="single"
                    flexDirection="column"
                    flexGrow={1}
                    paddingX={1}
                    width={layout.mainPanelWidth}
                >
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
