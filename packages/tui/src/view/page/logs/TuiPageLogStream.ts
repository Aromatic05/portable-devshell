import type { BoxModel } from "../../component/TuiComponentExpandableBox.js";
import type {
    TuiAppState,
    TuiLogEntry,
} from "../../../state/reducer/TuiStoreModel.js";
import type { TuiLogContextKey } from "./TuiPageLogSources.js";
import { buttonLine } from "../../editor/TuiEditorView.js";
import {
    compactSummary,
    makeBox,
    renderLogLine,
} from "../TuiPageBoxSupport.js";

export function buildLogContextBoxes(
    state: TuiAppState,
    instance: string,
    context: TuiLogContextKey,
): BoxModel[] {
    const label = context.kind === "unscoped" ? "unscoped" : context.ctxId;
    const sourceEntries = entriesForContext(
        state.logsByInstance[instance] ?? [],
        context,
    );
    const query = state.ui.searchQueries.logs ?? "";
    const filtered = filterLogEntries(sourceEntries, query);
    const following = state.ui.logsFollowByInstance[instance] !== false;
    const pausedAt = state.ui.logsPausedAtSeqByInstance[instance];
    const unseen =
        following || pausedAt === undefined
            ? 0
            : sourceEntries.filter((entry) => entry.seq > pausedAt).length;
    const stderr = sourceEntries.filter(
        (entry) => entry.stream === "stderr",
    ).length;

    return [
        makeBox(state, "logs", instance, {
            detailLines: [
                `Context            ${label}`,
                `Follow             ${following ? "on" : "paused"}`,
                `Filter             ${query.length === 0 ? "none" : query}`,
                `Total              ${sourceEntries.length}`,
                `Visible            ${filtered.length}`,
                `New while paused   ${unseen}`,
                "Filter syntax      stream: source: tool: call: after: before:",
                buttonLine("reload", "Reload"),
                buttonLine(
                    "toggle-follow",
                    following ? "Pause Follow" : "Resume Follow",
                ),
                buttonLine("clear-filter", "Clear Filter", query.length === 0),
                buttonLine(
                    "clear-buffer",
                    "Clear Buffer",
                    sourceEntries.length === 0,
                ),
            ],
            id: "logs-controls",
            status: stderr > 0 ? "warning" : following ? "running" : "warning",
            summaryLines: [
                compactSummary(
                    ["context", label],
                    ["follow", following ? "on" : "paused"],
                    ["visible", String(filtered.length)],
                ),
            ],
            title: "Log Controls",
        }),
        makeBox(state, "logs", instance, {
            detailLines:
                filtered.length === 0
                    ? [
                          query.length === 0
                              ? "No logs loaded for this source."
                              : `No logs match filter: ${query}`,
                      ]
                    : filtered.map((entry) => ({
                          id: `log:${entry.seq}`,
                          text: renderLogLine(entry),
                          tone:
                              entry.stream === "stderr"
                                  ? ("danger" as const)
                                  : ("muted" as const),
                      })),
            id: "logs",
            status: stderr > 0 ? "warning" : "normal",
            summaryLines: [
                compactSummary(
                    ["entries", String(filtered.length)],
                    ["context", label],
                ),
            ],
            title: query.length === 0 ? label : `${label} · filter: ${query}`,
        }),
    ];
}

export function filterLogEntries(
    entries: TuiLogEntry[],
    query: string,
): TuiLogEntry[] {
    const filters = parseLogQuery(query);
    return entries.filter((entry) => {
        if (filters.stream !== undefined && entry.stream !== filters.stream)
            return false;
        if (filters.source !== undefined && entry.source !== filters.source)
            return false;
        if (
            filters.tool !== undefined &&
            entry.toolName?.toLowerCase() !== filters.tool
        )
            return false;
        if (
            filters.call !== undefined &&
            entry.callId?.toLowerCase() !== filters.call
        )
            return false;
        const timestamp = entry.at ?? entry.receivedAt;
        if (filters.after !== undefined && timestamp < filters.after)
            return false;
        if (filters.before !== undefined && timestamp > filters.before)
            return false;
        const text = renderLogLine(entry).toLowerCase();
        return (
            filters.terms.length === 0 || text.includes(filters.terms.join(" "))
        );
    });
}

function entriesForContext(
    entries: TuiLogEntry[],
    context: TuiLogContextKey,
): TuiLogEntry[] {
    return context.kind === "unscoped"
        ? entries.filter(
              (entry) => entry.ctxId === undefined || entry.ctxId.length === 0,
          )
        : entries.filter((entry) => entry.ctxId === context.ctxId);
}

function parseLogQuery(query: string): {
    after?: string;
    before?: string;
    call?: string;
    source?: "cli" | "mcp" | "tui" | "web";
    stream?: "stderr" | "stdout";
    terms: string[];
    tool?: string;
} {
    const parsed: {
        after?: string;
        before?: string;
        call?: string;
        source?: "cli" | "mcp" | "tui" | "web";
        stream?: "stderr" | "stdout";
        terms: string[];
        tool?: string;
    } = { terms: [] };
    for (const token of query
        .trim()
        .toLowerCase()
        .split(/\s+/u)
        .filter(Boolean)) {
        const [field, ...rest] = token.split(":");
        const value = rest.join(":");
        if (field === "stream" && (value === "stdout" || value === "stderr"))
            parsed.stream = value;
        else if (
            field === "source" &&
            (value === "cli" ||
                value === "mcp" ||
                value === "tui" ||
                value === "web")
        )
            parsed.source = value;
        else if (field === "tool" && value.length > 0) parsed.tool = value;
        else if (field === "call" && value.length > 0) parsed.call = value;
        else if (
            (field === "after" || field === "before") &&
            !Number.isNaN(Date.parse(value))
        )
            parsed[field] = new Date(value).toISOString();
        else parsed.terms.push(token);
    }
    return parsed;
}
