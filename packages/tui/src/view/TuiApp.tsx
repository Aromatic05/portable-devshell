import { useCallback, useSyncExternalStore } from "react";
import { Box, Text, useInput } from "ink";

import { topTuiOverlay } from "../state/overlay/TuiOverlay.js";

import { TuiComponentErrorBanner } from "./component/TuiComponentErrorBanner.js";
import { TuiComponentFooter } from "./component/TuiComponentFooter.js";
import { TuiComponentHeader } from "./component/TuiComponentHeader.js";
import { TuiComponentSidebar } from "./component/TuiComponentSidebar.js";
import { TuiComponentTerminal } from "./component/TuiComponentTerminal.js";
import { TuiComponentTerminalTabs } from "./component/TuiComponentTerminalTabs.js";
import { TuiComponentTmuxPanes } from "./component/TuiComponentTmuxPanes.js";
import { TuiOverlayView } from "./overlay/TuiOverlayView.js";
import { TuiScreenRouter } from "./screen/TuiScreenRouter.js";
import {
    selectConnectionState,
    selectErrorMessage,
    selectFooterModel,
    selectHeaderSummary,
    selectHeaderTitle,
    selectSidebarModel,
    selectTerminalTab
} from "./model/TuiViewProjection.js";
import { tuiTerminalFullScreen } from "./TuiHitRegions.js";
import type { TuiAppController } from "./TuiAppController.js";
import { mainInnerWidth, tuiLayoutMetrics, TuiRootLayout } from "./TuiRootLayout.js";

export interface TuiAppProps {
    runtime: TuiAppController;
}

export function TuiApp(props: TuiAppProps) {
    const state = useSyncExternalStore(
        (listener) => props.runtime.scheduler.subscribe(listener),
        () => props.runtime.scheduler.getSnapshot(),
        () => props.runtime.scheduler.getSnapshot()
    );
    const connection = selectConnectionState(state);
    const errorLines = selectErrorMessage(state);
    const overlay = topTuiOverlay(state.interaction.overlays);
    const footer = selectFooterModel(state);
    const layout = tuiLayoutMetrics(props.runtime.columns);
    const fullWidth = tuiTerminalFullScreen(state);
    const boxInnerWidth = mainInnerWidth(props.runtime.columns, fullWidth);
    const viewportRows = Math.max(
        0,
        props.runtime.rows - (layout.mode === "compact" ? 10 : 7) - (errorLines?.length ?? 0) - (connection.status === "connecting" ? 1 : 0)
    );
    const terminalRows = Math.max(1, viewportRows - 1);
    const openTerminal = useCallback(
        async (instance: string | undefined, columns: number, rows: number) => {
            await props.runtime.openTerminal(instance, columns, rows);
        },
        [props.runtime]
    );
    const renderTerminalGraphics = useCallback(
        (visible: boolean) => props.runtime.renderTerminalGraphics(visible),
        [props.runtime]
    );
    const renderTextDetailImage = useCallback(
        (visible: boolean) => props.runtime.renderTextDetailImage(visible),
        [props.runtime]
    );
    useInput((input, key) => {
        void props.runtime.handleInput(input, key);
    });

    return (
        <TuiRootLayout
            columns={props.runtime.columns}
            footer={<TuiComponentFooter text={footer.text} />}
            header={<TuiComponentHeader stateLabel={connection.status} summary={selectHeaderSummary(state)} title={selectHeaderTitle()} />}
            main={
                <Box flexDirection="column" flexGrow={1}>
                    {errorLines !== undefined ? <TuiComponentErrorBanner lines={errorLines} /> : undefined}
                    {overlay !== undefined ? (
                        <TuiOverlayView
                            onTextDetailImageVisibility={renderTextDetailImage}
                            state={state}
                            viewportRows={viewportRows}
                            width={boxInnerWidth}
                        />
                    ) : state.ui.selectedPage === "terminal" ? (
                        <Box flexDirection="column" flexGrow={1}>
                            <TuiComponentTerminalTabs activeTab={selectTerminalTab(state)} focused={state.interaction.focusScope === "terminal"} />
                            {selectTerminalTab(state) === "tmuxPanes" ? (
                                <TuiComponentTmuxPanes
                                    columns={Math.max(1, boxInnerWidth)}
                                    focused={state.interaction.focusScope === "terminal"}
                                    instance={state.ui.selectedInstance}
                                    rows={Math.max(1, terminalRows - 1)}
                                    source={props.runtime.tmuxPanes}
                                />
                            ) : (
                                <TuiComponentTerminal
                                    columns={Math.max(1, boxInnerWidth)}
                                    focused={state.interaction.focusScope === "terminal"}
                                    instance={state.ui.selectedInstance}
                                    onGraphicsVisibility={renderTerminalGraphics}
                                    onOpen={openTerminal}
                                    rows={Math.max(1, terminalRows - 1)}
                                    source={props.runtime.terminal}
                                />
                            )}
                        </Box>
                    ) : (
                        <TuiScreenRouter
                            boxInnerWidth={boxInnerWidth}
                            state={state}
                            viewportRows={viewportRows}
                        />
                    )}
                    {connection.status === "connecting" ? <Text color="cyan">Connecting to control server...</Text> : undefined}
                </Box>
            }
            rows={props.runtime.rows}
            sidebar={
                fullWidth
                    ? undefined
                    : <TuiComponentSidebar compact={layout.mode === "compact"} model={selectSidebarModel(state)} />
            }
        />
    );
}
