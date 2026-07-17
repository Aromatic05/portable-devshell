import { useCallback, useSyncExternalStore } from "react";
import { Box, Text, useInput } from "ink";

import { TuiComponentConfirmDialog } from "./component/TuiComponentConfirmDialog.js";
import { TuiComponentErrorBanner } from "./component/TuiComponentErrorBanner.js";
import { TuiComponentFooter } from "./component/TuiComponentFooter.js";
import { TuiComponentHeader } from "./component/TuiComponentHeader.js";
import { TuiComponentSidebar } from "./component/TuiComponentSidebar.js";
import { TuiComponentTerminal } from "./component/TuiComponentTerminal.js";
import { TuiScreenRouter } from "./screen/TuiScreenRouter.js";
import {
    selectConnectionState,
    selectConfirmDialogModel,
    selectErrorMessage,
    selectFooterModel,
    selectHeaderSummary,
    selectHeaderTitle,
    selectSearchModel,
    selectSidebarModel
} from "./model/TuiViewProjection.js";
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
    const confirmDialog = selectConfirmDialogModel(state);
    const search = selectSearchModel(state);
    const toolForm = state.interaction.toolForm;
    const auditDetailOpen = state.ui.selectedPage === "audit" && state.interaction.auditPage.mode !== "list";
    const footer = selectFooterModel(state);
    const layout = tuiLayoutMetrics(props.runtime.columns);
    const boxInnerWidth = mainInnerWidth(props.runtime.columns);
    const viewportRows = Math.max(
        0,
        props.runtime.rows - (layout.mode === "compact" ? 10 : 7) - (errorLines?.length ?? 0) - (search.open ? 1 : 0) - (connection.status === "connecting" ? 1 : 0)
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
                    {search.open ? <Text color="cyan">{`/ ${search.query}`}</Text> : undefined}
                    {toolForm?.open === true && !auditDetailOpen ? (
                        <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
                            <Text bold>{`Call Tool: ${toolForm.toolName}`}</Text>
                            <Text dimColor>{`instance ${toolForm.instance}`}</Text>
                            <Text color="cyan">{toolForm.input}</Text>
                            <Text dimColor>Enter submit, Esc cancel</Text>
                        </Box>
                    ) : undefined}
                    {state.ui.selectedPage === "terminal" ? (
                        <TuiComponentTerminal
                            columns={Math.max(1, boxInnerWidth)}
                            focused={state.interaction.focusScope === "terminal"}
                            instance={state.ui.selectedInstance}
                            onGraphicsVisibility={renderTerminalGraphics}
                            onOpen={openTerminal}
                            rows={terminalRows}
                            source={props.runtime.terminal}
                        />
                    ) : (
                        <TuiScreenRouter boxInnerWidth={boxInnerWidth} state={state} viewportRows={viewportRows} />
                    )}
                    {!auditDetailOpen ? (
                        <TuiComponentConfirmDialog
                            body={confirmDialog.body}
                            cancelFocused={confirmDialog.cancelFocused}
                            cancelLabel={confirmDialog.cancelLabel}
                            confirmFocused={confirmDialog.confirmFocused}
                            confirmLabel={confirmDialog.confirmLabel}
                            open={confirmDialog.open}
                            title={confirmDialog.title}
                        />
                    ) : undefined}
                    {connection.status === "connecting" ? <Text color="cyan">Connecting to control server...</Text> : undefined}
                </Box>
            }
            rows={props.runtime.rows}
            sidebar={<TuiComponentSidebar compact={layout.mode === "compact"} model={selectSidebarModel(state)} />}
        />
    );
}
