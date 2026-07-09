import React from "react";

import type { TuiAppState } from "../store/TuiReducers.js";
import {
    selectActivePanel,
    selectAuditLines,
    selectConfigLines,
    selectConnectorLines,
    selectHelpLines,
    selectInstanceRows,
    selectLogLines,
    selectPanelTitle
} from "../store/TuiSelectors.js";
import { PlaceholderScreen } from "./PlaceholderScreen.js";

export interface ScreenRouterProps {
    state: TuiAppState;
}

export function ScreenRouter(props: ScreenRouterProps) {
    const panel = selectActivePanel(props.state);

    switch (panel) {
        case "instances":
            return <PlaceholderScreen lines={selectInstanceRows(props.state)} title={selectPanelTitle(panel)} />;
        case "config":
            return <PlaceholderScreen lines={selectConfigLines(props.state)} title={selectPanelTitle(panel)} />;
        case "connector":
            return <PlaceholderScreen lines={selectConnectorLines(props.state)} title={selectPanelTitle(panel)} />;
        case "audit":
            return <PlaceholderScreen lines={selectAuditLines(props.state)} title={selectPanelTitle(panel)} />;
        case "logs":
            return <PlaceholderScreen lines={selectLogLines(props.state)} title={selectPanelTitle(panel)} />;
        case "help":
            return <PlaceholderScreen lines={selectHelpLines()} title={selectPanelTitle(panel)} />;
    }
}
