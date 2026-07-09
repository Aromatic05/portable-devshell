import React, { useSyncExternalStore } from "react";
import { Box, Text, useInput } from "ink";

import { ActionMenu } from "../component/ActionMenu.js";
import { ConfirmDialog } from "../component/ConfirmDialog.js";
import { ErrorBanner } from "../component/ErrorBanner.js";
import { Footer } from "../component/Footer.js";
import { Header } from "../component/Header.js";
import { Sidebar } from "../component/Sidebar.js";
import { ScreenRouter } from "../screen/ScreenRouter.js";
import {
    selectActionMenuModel,
    selectConnectionState,
    selectConfirmDialogModel,
    selectErrorMessage,
    selectFooterModel,
    selectHeaderSummary,
    selectHeaderTitle,
    selectSearchModel,
    selectSidebarModel
} from "../store/TuiSelectors.js";
import type { TuiRuntime } from "./TuiRuntime.js";
import { TuiRootLayout } from "./TuiRootLayout.js";

export interface TuiAppProps {
    runtime: TuiRuntime;
}

export function TuiApp(props: TuiAppProps) {
    const state = useSyncExternalStore(
        (listener) => props.runtime.scheduler.subscribe(listener),
        () => props.runtime.scheduler.getSnapshot(),
        () => props.runtime.scheduler.getSnapshot()
    );
    const connection = selectConnectionState(state);
    const errorLines = selectErrorMessage(state);
    const actionMenu = selectActionMenuModel(state);
    const confirmDialog = selectConfirmDialogModel(state);
    const search = selectSearchModel(state);
    const footer = selectFooterModel(state);
    const boxInnerWidth = Math.max(32, props.runtime.columns - 28);

    useInput((input, key) => {
        void props.runtime.handleInput(input, key);
    });

    return (
        <TuiRootLayout
            columns={props.runtime.columns}
            footer={<Footer text={footer.text} />}
            header={<Header stateLabel={connection.status} summary={selectHeaderSummary(state)} title={selectHeaderTitle()} />}
            main={
                <Box flexDirection="column" flexGrow={1} gap={1}>
                    {errorLines !== undefined ? <ErrorBanner lines={errorLines} /> : undefined}
                    {search.open ? <Text color="cyan">{`/ ${search.query}`}</Text> : undefined}
                    <ScreenRouter boxInnerWidth={boxInnerWidth} state={state} />
                    <ActionMenu items={actionMenu.items} open={actionMenu.open} title={actionMenu.title} />
                    <ConfirmDialog
                        body={confirmDialog.body}
                        cancelFocused={confirmDialog.cancelFocused}
                        cancelLabel={confirmDialog.cancelLabel}
                        confirmFocused={confirmDialog.confirmFocused}
                        confirmLabel={confirmDialog.confirmLabel}
                        open={confirmDialog.open}
                        title={confirmDialog.title}
                    />
                    {connection.status === "connecting" ? <Text color="cyan">Connecting to control server...</Text> : undefined}
                </Box>
            }
            rows={props.runtime.rows}
            sidebar={<Sidebar model={selectSidebarModel(state)} />}
        />
    );
}
