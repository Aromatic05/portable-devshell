import type { BoxModel } from "../../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import { compactSummary, formatField, makeBox } from "../TuiPageBoxSupport.js";

export function buildLogSourceBoxes(state: TuiAppState, instance: string): BoxModel[] {
    const logs = state.logsByInstance[instance] ?? [];
    const diagnostics = logs.filter((entry) => entry.callId !== undefined || entry.ctxId !== undefined || entry.toolName !== undefined);
    return [
        makeBox(state, "logs", instance, {
            detailLines: [
                formatField("Entries", String(logs.length)),
                formatField("stdout", String(logs.filter((entry) => entry.stream === "stdout").length)),
                formatField("stderr", String(logs.filter((entry) => entry.stream === "stderr").length)),
                formatField("Latest", logs.at(-1)?.at ?? logs.at(-1)?.receivedAt ?? "-")
            ],
            id: "log-source:instance",
            primaryRoute: { page: "logs", sourceId: "instance", view: "stream" },
            status: logs.some((entry) => entry.stream === "stderr") ? "warning" : "normal",
            summaryLines: [compactSummary(["entries", String(logs.length)], ["source", "instance"])],
            title: "Instance Log"
        }),
        makeBox(state, "logs", instance, {
            detailLines: [
                formatField("Entries", String(diagnostics.length)),
                "Includes records linked to a context, tool call, or request."
            ],
            id: "log-source:audit-diagnostics",
            primaryRoute: { page: "logs", sourceId: "audit-diagnostics", view: "stream" },
            status: diagnostics.some((entry) => entry.stream === "stderr") ? "warning" : "normal",
            summaryLines: [compactSummary(["entries", String(diagnostics.length)], ["source", "audit-diagnostics"])],
            title: "Audit Diagnostics"
        })
    ];
}
