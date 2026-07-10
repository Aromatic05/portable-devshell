import type { BoxModel } from "../../component/ExpandableBox.js";
import type { PageId } from "../../model/TuiUiTypes.js";
import type { TuiAppState } from "../TuiReducers.js";
import { buildAuditPageBoxes } from "./audit.js";
import { buildConfigPageBoxes } from "./config.js";
import { buildConnectorPageBoxes } from "./connector.js";
import { buildHelpPageBoxes } from "./help.js";
import { buildInstancesPageBoxes } from "./instances.js";
import { buildLogsPageBoxes } from "./logs.js";

export function buildBoxesForPage(state: TuiAppState, page: PageId, instanceName: string | undefined): BoxModel[] {
    const boxes = (() => {
        switch (page) {
            case "help":
                return buildHelpPageBoxes(state);
            case "instances":
                return buildInstancesPageBoxes(state);
            case "config":
                return instanceName === undefined ? [] : buildConfigPageBoxes(state, instanceName);
            case "connector":
                return instanceName === undefined ? [] : buildConnectorPageBoxes(state, instanceName);
            case "audit":
                return instanceName === undefined ? [] : buildAuditPageBoxes(state, instanceName);
            case "logs":
                return instanceName === undefined ? [] : buildLogsPageBoxes(state, instanceName);
        }
    })();

    return boxes;
}
