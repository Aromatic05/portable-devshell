import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState, TuiLogEntry } from "../TuiReducers.js";
import { buildSelectedInstancePageContext, compactSummary, makeBox, renderLogLine } from "./PageBoxSupport.js";
import { buttonLine } from "./EditorSupport.js";

export function buildLogsPageBoxes(state: TuiAppState, instanceName: string): BoxModel[] {
    const { logs } = buildSelectedInstancePageContext(state, instanceName);
    const query = state.ui.searchQueries.logs ?? "";
    const filtered = filterLogEntries(logs, query);
    const stdout = logs.filter((entry) => entry.stream === "stdout").length;
    const stderr = logs.filter((entry) => entry.stream === "stderr").length;
    const following = state.ui.logsFollowByInstance[instanceName] !== false;
    const last = logs.at(-1);
    const pausedAt = state.ui.logsPausedAtSeqByInstance[instanceName];
    const unseen = following || pausedAt === undefined ? 0 : logs.filter((entry) => entry.seq > pausedAt).length;

    return [
        makeBox(state, "logs", instanceName, {
            detailLines: [
                `Follow             ${following ? "on" : "paused"}`,
                `Filter             ${query.length === 0 ? "none" : query}`,
                `Total              ${logs.length}`,
                `Visible            ${filtered.length}`,
                `New while paused  ${unseen}`,
                `stdout             ${stdout}`,
                `stderr             ${stderr}`,
                `Last event         ${last?.at ?? "-"}`,
                "Filter syntax     stream: source: tool: call: after: before:",
                "Select a linked log entry to open its audit record.",
                "",
                buttonLine("reload", "Reload"),
                buttonLine("toggle-follow", following ? "Pause Follow" : "Resume Follow"),
                buttonLine("clear-filter", "Clear Filter", query.length === 0),
                buttonLine("clear-buffer", "Clear Buffer", logs.length === 0)
            ],
            id: "logs-controls",
            status: stderr > 0 ? "warning" : following ? "running" : "warning",
            summaryLines: [compactSummary(["follow", following ? "on" : "paused"], ["visible", String(filtered.length)], ["new", String(unseen)])],
            title: "Log Controls & Statistics"
        }),
        makeBox(state, "logs", instanceName, {
            detailLines: filtered.length === 0
                ? [query.length === 0 ? "No logs loaded yet." : `No logs match filter: ${query}`]
                : filtered.map((entry) => ({
                      id: `log:${entry.seq}`,
                      text: renderLogLine(entry),
                      tone: entry.stream === "stderr" ? "danger" as const : "muted" as const
                  })),
            id: "logs",
            status: stderr > 0 ? "warning" : "normal",
            summaryLines: [compactSummary(["entries", String(filtered.length)], ["stream", `stdout:${stdout}/stderr:${stderr}`])],
            title: query.length === 0 ? "Logs" : `Logs · filter: ${query}`
        })
    ];
}

export function filterLogEntries(entries: TuiLogEntry[], query: string): TuiLogEntry[] {
    const filters = parseLogQuery(query);
    return entries.filter((entry) => {
        if (filters.stream !== undefined && entry.stream !== filters.stream) return false;
        if (filters.source !== undefined && entry.source !== filters.source) return false;
        if (filters.tool !== undefined && entry.toolName?.toLowerCase() !== filters.tool) return false;
        if (filters.call !== undefined && entry.callId?.toLowerCase() !== filters.call) return false;
        const timestamp = entry.at ?? entry.receivedAt;
        if (filters.after !== undefined && timestamp < filters.after) return false;
        if (filters.before !== undefined && timestamp > filters.before) return false;
        const text = renderLogLine(entry).toLowerCase();
        return filters.terms.length === 0 || text.includes(filters.terms.join(" "));
    });
}

function parseLogQuery(query: string): { after?: string; before?: string; call?: string; source?: "cli" | "mcp" | "tui"; stream?: "stderr" | "stdout"; terms: string[]; tool?: string } {
    const parsed: { after?: string; before?: string; call?: string; source?: "cli" | "mcp" | "tui"; stream?: "stderr" | "stdout"; terms: string[]; tool?: string } = { terms: [] };
    for (const token of query.trim().toLowerCase().split(/\s+/u).filter(Boolean)) {
        const [field, ...rest] = token.split(":");
        const value = rest.join(":");
        if (field === "stream" && (value === "stdout" || value === "stderr")) parsed.stream = value;
        else if (field === "source" && (value === "cli" || value === "mcp" || value === "tui")) parsed.source = value;
        else if (field === "tool" && value.length > 0) parsed.tool = value;
        else if (field === "call" && value.length > 0) parsed.call = value;
        else if ((field === "after" || field === "before") && !Number.isNaN(Date.parse(value))) parsed[field] = new Date(value).toISOString();
        else parsed.terms.push(token);
    }
    return parsed;
}
