import { useCallback, useSyncExternalStore } from "react";
import { Box, Text, useInput } from "ink";
import { topTuiOverlay } from "../../state/Overlay.js";
import { TuiComponentErrorBanner } from "../component/chrome/Error.js";
import { TuiComponentFooter } from "../component/chrome/Footer.js";
import { TuiComponentHeader } from "../component/chrome/Header.js";
import { TuiComponentSidebar } from "../component/Sidebar.js";
import { TuiComponentTerminal, type TuiTerminalRenderSource } from "../../terminal/control/View.js";
import { TuiComponentTerminalTabs, TuiComponentTmuxPanes, type TuiTmuxPanesRenderSource } from "../../terminal/tmux/View.js";
import { TuiComponentTextSelection } from "../component/Selection.js";
import { TuiOverlayView } from "../overlay/View.js";
import { TuiScreenRouter } from "./Router.js";
import { selectConnectionState, selectErrorMessage, selectFooterModel, selectHeaderSummary, selectHeaderTitle, selectSidebarModel, selectTerminalTab } from "../projection/View.js";
import { tuiTerminalFullScreen } from "../projection/HitRegion.js";
import { tuiBlockHeight, tuiMainLayoutMetrics, TuiRootLayout } from "./Layout.js";
import { type TuiAppState } from "../../state/store/Model.js";
import { type TuiTerminalTab } from "../../state/route/Model.js";
import { type TuiTextSelectionRenderSource } from "../../interaction/selection/Model.js";
import { type TuiViewportRenderSource } from "../../app/Render.js";

export interface TuiAppProps {
    runtime: TuiAppController;
}

export function TuiApp(props: TuiAppProps) {
    const state = useSyncExternalStore(
        (listener) => props.runtime.scheduler.subscribe(listener),
        () => props.runtime.scheduler.getSnapshot(),
        () => props.runtime.scheduler.getSnapshot()
    );
    const viewport = useSyncExternalStore(
        (listener) => props.runtime.viewport.subscribe(listener),
        () => props.runtime.viewport.getSnapshot(),
        () => props.runtime.viewport.getSnapshot(),
    );
    const connection = selectConnectionState(state);
    const errorLines = selectErrorMessage(state);
    const overlay = topTuiOverlay(state.interaction.overlays);
    const footer = selectFooterModel(state);
    const fullWidth = tuiTerminalFullScreen(state);
    const geometry = tuiMainLayoutMetrics(
        viewport.columns,
        viewport.rows,
        !fullWidth,
    );
    const layout = geometry.layout;
    const renderRows = geometry.renderRows;
    const contentWidth = geometry.contentWidth;
    const boxInnerWidth = geometry.boxInnerWidth;
    const viewportRows = Math.max(
        0,
        geometry.contentHeight -
            tuiBlockHeight(errorLines) -
            (connection.status === "connecting" ? 1 : 0),
    );
    const terminalRows = Math.max(1, viewportRows - 1);
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
        <Box height={renderRows} width={viewport.columns}>
            <TuiRootLayout
            columns={viewport.columns}
            footer={<TuiComponentFooter text={footer.text} />}
            header={<TuiComponentHeader stateLabel={connection.status} summary={selectHeaderSummary(state)} title={selectHeaderTitle()} />}
            main={
                <Box
                    flexDirection="column"
                    flexGrow={1}
                >
                    {errorLines !== undefined ? <TuiComponentErrorBanner lines={errorLines} /> : undefined}
                    {overlay !== undefined ? (
                        <TuiOverlayView
                            onTextDetailImageVisibility={renderTextDetailImage}
                            state={state}
                            viewportRows={viewportRows}
                            width={contentWidth}
                        />
                    ) : state.ui.selectedPage === "terminal" ? (
                        <Box flexDirection="column" flexGrow={1}>
                            <TuiComponentTerminalTabs activeTab={selectTerminalTab(state)} focused={state.interaction.focusScope === "terminal"} />
                            {selectTerminalTab(state) === "tmuxPanes" ? (
                                <TuiComponentTmuxPanes
                                    columns={Math.max(1, contentWidth)}
                                    focused={state.interaction.focusScope === "terminal"}
                                    instance={state.ui.selectedInstance}
                                    rows={Math.max(1, terminalRows - 1)}
                                    source={props.runtime.tmuxPanes}
                                />
                            ) : (
                                <TuiComponentTerminal
                                    columns={Math.max(1, contentWidth)}
                                    focused={state.interaction.focusScope === "terminal"}
                                    instance={state.ui.selectedInstance}
                                    onGraphicsVisibility={renderTerminalGraphics}
                                    rows={Math.max(1, terminalRows - 1)}
                                    source={props.runtime.terminal}
                                />
                            )}
                        </Box>
                    ) : (
                        <TuiScreenRouter
                            boxInnerWidth={boxInnerWidth}
                            contentWidth={contentWidth}
                            state={state}
                            viewportRows={viewportRows}
                        />
                    )}
                    {connection.status === "connecting" ? <Text color="cyan">Connecting to control server...</Text> : undefined}
                </Box>
            }
            rows={viewport.rows}
            sidebar={
                fullWidth
                    ? undefined
                    : <TuiComponentSidebar
                        columns={viewport.columns}
                        compact={layout.mode === "compact"}
                        model={selectSidebarModel(state)}
                        rows={Math.max(0, renderRows - 6)}
                    />
            }
            />
            <TuiComponentTextSelection source={props.runtime.selection} />
        </Box>
    );
}

export interface TuiAppKey {
    backspace?: boolean;
    ctrl?: boolean;
    delete?: boolean;
    downArrow?: boolean;
    escape?: boolean;
    end?: boolean;
    home?: boolean;
    leftArrow?: boolean;
    pageDown?: boolean;
    pageUp?: boolean;
    return?: boolean;
    rightArrow?: boolean;
    shift?: boolean;
    tab?: boolean;
    upArrow?: boolean;
}

export interface TuiAppRenderSource {
    getSnapshot(): TuiAppState;
    subscribe(listener: () => void): () => void;
}

export interface TuiAppController {
    readonly columns: number;
    readonly rows: number;
    readonly scheduler: TuiAppRenderSource;
    readonly selection: TuiTextSelectionRenderSource;
    readonly terminal: TuiTerminalRenderSource;
    readonly tmuxPanes: TuiTmuxPanesRenderSource;
    readonly viewport: TuiViewportRenderSource;
    handleInput(input: string, key: TuiAppKey): Promise<void>;
    renderTextDetailImage(visible: boolean): void;
    renderTerminalGraphics(visible: boolean): void;
    selectTerminalTab(tab: TuiTerminalTab): void;
}
