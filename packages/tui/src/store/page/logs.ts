import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState } from "../TuiReducers.js";
import { applySearch, buildSelectedInstancePageContext, compactSummary, makeBox, renderLogLine } from "./PageBoxSupport.js";

export function buildLogsPageBoxes(state: TuiAppState, instanceName: string): BoxModel[] {
    const { logs } = buildSelectedInstancePageContext(state, instanceName);
    const filtered = applySearch(logs.map(renderLogLine), state.ui.searchQueries.logs ?? "");

    return [
        makeBox(state, "logs", instanceName, {
            detailLines: filtered.length === 0 ? ["No logs loaded yet."] : filtered,
            id: "logs",
            status: "normal",
            summaryLines: [compactSummary(["source", "instance.readLogs+log.appended"], ["entries", String(logs.length)])],
            title: "Logs"
        }),
        makeBox(state, "logs", instanceName, {
            detailLines: [
                "Logs page only reads instance.readLogs.",
                "Live updates only append from log.appended stream events.",
                "worker.log is never read directly."
            ],
            id: "logs-source",
            status: "normal",
            summaryLines: [compactSummary(["source", "instance.readLogs"], ["stream", "log.appended"])],
            title: "Source"
        })
    ];
}
