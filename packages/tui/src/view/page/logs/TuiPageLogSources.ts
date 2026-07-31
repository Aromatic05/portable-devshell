import type { TuiLogEntry } from "../../../state/reducer/TuiStoreModel.js";
import type { BoxModel } from "../../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import { compactSummary, formatField, makeBox } from "../TuiPageBoxSupport.js";

export type TuiLogContextKey =
    | { readonly kind: "unscoped" }
    | { readonly ctxId: string; readonly kind: "context" };

interface TuiLogContextSummary {
    readonly key: TuiLogContextKey;
    readonly label: string;
    readonly entries: readonly TuiLogEntry[];
    readonly latestAt: string;
}

export function buildLogContextListBoxes(
    state: TuiAppState,
    instance: string,
): BoxModel[] {
    const contexts = projectLogContexts(state.logsByInstance[instance] ?? []);
    if (contexts.length === 0) {
        return [
            makeBox(state, "logs", instance, {
                detailLines: ["No logs are available for this instance."],
                expandable: false,
                id: "log-contexts-empty",
                status: "normal",
                summaryLines: ["contexts=0"],
                title: "Log Contexts",
            }),
        ];
    }

    return contexts.map((context) =>
        makeBox(state, "logs", instance, {
            detailLines: [
                formatField("Context", context.label),
                formatField("Entries", String(context.entries.length)),
                formatField(
                    "stdout",
                    String(
                        context.entries.filter(
                            (entry) => entry.stream === "stdout",
                        ).length,
                    ),
                ),
                formatField(
                    "stderr",
                    String(
                        context.entries.filter(
                            (entry) => entry.stream === "stderr",
                        ).length,
                    ),
                ),
                formatField("Latest", context.latestAt),
            ],
            id:
                context.key.kind === "unscoped"
                    ? "log-context:unscoped"
                    : `log-context:${context.key.ctxId}`,
            primaryRoute:
                context.key.kind === "unscoped"
                    ? { page: "logs", scope: "unscoped", view: "context" }
                    : {
                          ctxId: context.key.ctxId,
                          page: "logs",
                          scope: "context",
                          view: "context",
                      },
            searchText: `${context.label} ${context.entries.map((entry) => entry.toolName ?? "").join(" ")}`,
            status: context.entries.some((entry) => entry.stream === "stderr")
                ? "warning"
                : "normal",
            summaryLines: [
                compactSummary(
                    ["entries", String(context.entries.length)],
                    [
                        "stderr",
                        String(
                            context.entries.filter(
                                (entry) => entry.stream === "stderr",
                            ).length,
                        ),
                    ],
                    ["latest", context.latestAt],
                ),
            ],
            title: context.label,
        }),
    );
}

export function projectLogContexts(
    entries: readonly TuiLogEntry[],
): TuiLogContextSummary[] {
    const grouped = new Map<
        string,
        { entries: TuiLogEntry[]; key: TuiLogContextKey; label: string }
    >();
    for (const entry of entries) {
        const key: TuiLogContextKey =
            entry.ctxId === undefined || entry.ctxId.length === 0
                ? { kind: "unscoped" }
                : { ctxId: entry.ctxId, kind: "context" };
        const groupKey =
            key.kind === "unscoped" ? "unscoped:" : `context:${key.ctxId}`;
        const current = grouped.get(groupKey) ?? {
            entries: [],
            key,
            label: key.kind === "unscoped" ? "unscoped" : key.ctxId,
        };
        current.entries.push(entry);
        grouped.set(groupKey, current);
    }

    return [...grouped.values()]
        .map(({ entries: contextEntries, key, label }) => {
            const sorted = [...contextEntries].sort((left, right) =>
                logTimestamp(left).localeCompare(logTimestamp(right)),
            );
            return {
                entries: sorted,
                key,
                label,
                latestAt: logTimestamp(sorted.at(-1)),
            };
        })
        .sort((left, right) => right.latestAt.localeCompare(left.latestAt));
}

function logTimestamp(entry: TuiLogEntry | undefined): string {
    return entry?.at ?? entry?.receivedAt ?? "-";
}
