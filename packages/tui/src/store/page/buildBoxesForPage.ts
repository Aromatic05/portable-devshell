import type { BoxModel } from "../../component/ExpandableBox.js";
import type { PageId } from "../../model/TuiUiTypes.js";
import type { TuiAppState } from "../TuiReducers.js";
import { buildAuditPageBoxes } from "./audit.js";
import { buildConfigPageBoxes } from "./config.js";
import { buildConnectorPageBoxes } from "./connector.js";
import { buildHelpPageBoxes } from "./help.js";
import { buildInstancesPageBoxes } from "./instances.js";
import { buildLogsPageBoxes } from "./logs.js";
import { buildOAuthPageBoxes } from "./oauth.js";

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
            case "oauth":
                return buildOAuthPageBoxes(state);
            case "audit":
                return instanceName === undefined ? [] : buildAuditPageBoxes(state, instanceName);
            case "logs":
                return instanceName === undefined ? [] : buildLogsPageBoxes(state, instanceName);
        }
    })();

    if (page === "instances" || page === "config" || page === "audit") {
        return filterBoxes(boxes, state.ui.searchQueries[page] ?? "");
    }

    return boxes;
}

function filterBoxes(boxes: BoxModel[], query: string): BoxModel[] {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) {
        return boxes;
    }

    return boxes.filter((box) =>
        [
            box.title,
            ...box.collapsedLines.map((line) => line.text),
            ...box.expandedLines.map((line) => line.text)
        ]
            .join("\n")
            .toLowerCase()
            .includes(normalized)
    );
}
