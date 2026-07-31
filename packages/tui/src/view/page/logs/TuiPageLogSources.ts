import type { TuiLogEntry } from "../../../state/reducer/TuiStoreModel.js";
import type { BoxModel } from "../../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import { compactSummary, formatField, makeBox } from "../TuiPageBoxSupport.js";

interface TuiLogContextSummary {
    readonly ctxId: string;
    readonly entries: readonly TuiLogEntry[];
    readonly latestAt: string;
}

export function buildLogContextListBoxes(state: TuiAppState, instance: string): BoxModel[] {
    const contexts = projectLogContexts(state.logsByInstance[instance] ?? []);
    if (contexts.length === 0) {
        return [makeBox(state, "logs", instance, {
            detailLines: ["No logs are available for this instance."],
            expandable: false,
            id: "log-contexts-empty",
            status: "normal",
            summaryLines: ["contexts=0"],
            title: "Log Contexts"
        })];
    }

    return contexts.map((context) => makeBox(state, "logs", instance, {
        detailLines: [
            formatField("Context", context.ctxId),
            formatField("Entries", String(context.entries.length)),
            formatField("stdout", String(context.entries.filter((entry) => entry.stream === "stdout").length)),
            formatField("stderr", String(context.entries.filter((entry) => entry.stream === "stderr").length)),
            formatField("Latest", context.latestAt)
        ],
        id: `log-context:${context.ctxId}`,
        primaryRoute: { ctxId: context.ctxId, page: "logs", view: "context" },
        searchText: `${context.ctxId} ${context.entries.map((entry) => entry.toolName ?? "").join(" ")}`,
        status: context.entries.some((entry) => entry.stream === "stderr") ? "warning" : "normal",
        summaryLines: [
            compactSummary(
                ["entries", String(context.entries.length)],
                ["stderr", String(context.entries.filter((entry) => entry.stream === "stderr").length)],
                ["latest", context.latestAt]
            )
        ],
        title: context.ctxId
    }));
}

export function projectLogContexts(entries: readonly TuiLogEntry[]): TuiLogContextSummary[] {
    const grouped = new Map<string, TuiLogEntry[]>();
    for (const entry of entries) {
        const ctxId = entry.ctxId === undefined || entry.ctxId.length === 0 ? "unscoped" : entry.ctxId;
        const contextEntries = grouped.get(ctxId) ?? [];
        contextEntries.push(entry);
        grouped.set(ctxId, contextEntries);
    }

    return [...grouped.entries()]
        .map(([ctxId, contextEntries]) => {
            const sorted = [...contextEntries].sort((left, right) => logTimestamp(left).localeCompare(logTimestamp(right)));
            return {
                ctxId,
                entries: sorted,
                latestAt: logTimestamp(sorted.at(-1))
            };
        })
        .sort((left, right) => right.latestAt.localeCompare(left.latestAt));
}

function logTimestamp(entry: TuiLogEntry | undefined): string {
    return entry?.at ?? entry?.receivedAt ?? "-";
}
