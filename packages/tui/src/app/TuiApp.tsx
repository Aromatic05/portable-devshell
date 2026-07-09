import React, { useSyncExternalStore } from "react";
import { Box, Text, useInput } from "ink";

import { ErrorBanner } from "../component/ErrorBanner.js";
import { Footer } from "../component/Footer.js";
import { Header } from "../component/Header.js";
import { Sidebar } from "../component/Sidebar.js";
import { ScreenRouter } from "../screen/ScreenRouter.js";
import type { TuiPanel } from "../store/TuiReducers.js";
import {
    selectConnectionState,
    selectErrorMessage,
    selectFooterText,
    selectHeaderSummary,
    selectHeaderTitle,
    selectSidebarItems
} from "../store/TuiSelectors.js";
import type { TuiRuntime } from "./TuiRuntime.js";
import { TuiRootLayout } from "./TuiRootLayout.js";

const orderedPanels: TuiPanel[] = ["instances", "config", "connector", "audit", "logs", "help"];

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

    useInput((input, key) => {
        if (input === "q" || key.ctrl && input === "c") {
            void props.runtime.stop();
            return;
        }

        if (input === "r") {
            void props.runtime.reconnect();
            return;
        }

        if (key.upArrow) {
            props.runtime.store.setActivePanel(previousPanel(state.activePanel));
            return;
        }

        if (key.downArrow) {
            props.runtime.store.setActivePanel(nextPanel(state.activePanel));
            return;
        }

        const index = Number.parseInt(input, 10);

        if (Number.isInteger(index) && index >= 1 && index <= orderedPanels.length) {
            props.runtime.store.setActivePanel(orderedPanels[index - 1] ?? "instances");
        }
    });

    return (
        <TuiRootLayout
            footer={<Footer text={selectFooterText(state)} />}
            header={<Header stateLabel={connection.status} summary={selectHeaderSummary(state)} title={selectHeaderTitle()} />}
            main={
                <Box flexDirection="column" flexGrow={1} gap={1}>
                    {errorLines !== undefined ? <ErrorBanner lines={errorLines} /> : undefined}
                    <ScreenRouter state={state} />
                    {connection.status === "connecting" ? <Text color="cyan">Connecting to control server...</Text> : undefined}
                </Box>
            }
            sidebar={<Sidebar items={selectSidebarItems(state)} />}
        />
    );
}

function nextPanel(current: TuiPanel): TuiPanel {
    const index = orderedPanels.indexOf(current);
    return orderedPanels[(index + 1) % orderedPanels.length] ?? "instances";
}

function previousPanel(current: TuiPanel): TuiPanel {
    const index = orderedPanels.indexOf(current);
    return orderedPanels[(index - 1 + orderedPanels.length) % orderedPanels.length] ?? "instances";
}
