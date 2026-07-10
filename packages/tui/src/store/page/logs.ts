import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState } from "../TuiReducers.js";
import { applySearch, buildSelectedInstancePageContext, compactSummary, makeBox, renderLogLine } from "./PageBoxSupport.js";
import { buttonLine } from "./EditorSupport.js";

export function buildLogsPageBoxes(state: TuiAppState, instanceName: string): BoxModel[] {
    const { logs } = buildSelectedInstancePageContext(state, instanceName);
    const query = state.ui.searchQueries.logs ?? "";
    const filtered = applySearch(logs.map(renderLogLine), query);
    const stdout = logs.filter((entry) => entry.stream === "stdout").length;
    const stderr = logs.filter((entry) => entry.stream === "stderr").length;
    const following = state.ui.logsFollowByInstance[instanceName] !== false;
    const last = logs.at(-1);

    return [
        makeBox(state, "logs", instanceName, {
            detailLines: [
                `Follow             ${following ? "on" : "paused"}`,
                `Filter             ${query.length === 0 ? "none" : query}`,
                `Total              ${logs.length}`,
                `Visible            ${filtered.length}`,
                `stdout             ${stdout}`,
                `stderr             ${stderr}`,
                `Last event         ${last?.at ?? "-"}`,
                "",
                buttonLine("reload", "Reload"),
                buttonLine("toggle-follow", following ? "Pause Follow" : "Resume Follow"),
                buttonLine("clear-filter", "Clear Filter", query.length === 0),
                buttonLine("clear-buffer", "Clear Buffer", logs.length === 0)
            ],
            id: "logs-controls",
            status: following ? "running" : "warning",
            summaryLines: [compactSummary(["follow", following ? "on" : "paused"], ["visible", String(filtered.length)], ["total", String(logs.length)])],
            title: "Log Controls & Statistics"
        }),
        makeBox(state, "logs", instanceName, {
            detailLines: filtered.length === 0 ? [query.length === 0 ? "No logs loaded yet." : `No logs match filter: ${query}`] : filtered,
            id: "logs",
            status: "normal",
            summaryLines: [compactSummary(["entries", String(filtered.length)], ["stream", `stdout:${stdout}/stderr:${stderr}`])],
            title: query.length === 0 ? "Logs" : `Logs · filter: ${query}`
        })
    ];
}
