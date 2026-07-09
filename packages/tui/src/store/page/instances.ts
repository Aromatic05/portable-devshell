import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState } from "../TuiReducers.js";
import { compactSummary, formatField, makeBox, runtimeStatus } from "./PageBoxSupport.js";

export function buildInstancesPageBoxes(state: TuiAppState): BoxModel[] {
    if (state.instances.length === 0) {
        return [
            makeBox(state, "instances", "instances", {
                detailLines: ["No instances loaded from control.listInstances."],
                id: "instances-empty",
                status: "warning",
                summaryLines: ["instances=0"],
                title: "Instances"
            })
        ];
    }

    return state.instances.map((entry) => {
        const snapshot = state.snapshotsByInstance[entry.name];
        const logs = state.logsByInstance[entry.name] ?? [];
        const approvals = (state.approvalsByInstance[entry.name] ?? []).filter((approval) => approval.status === "pending");
        const status = entry.enabled ? runtimeStatus(snapshot) : "disabled";
        const summaryLines = [
            compactSummary(
                ["provider", entry.provider ?? "unknown"],
                ["daemon", snapshot?.daemonState ?? "unknown"],
                ["ready", snapshot?.ready === true ? "yes" : "no"],
                ["seq", String(state.lastSeqByInstance[entry.name] ?? snapshot?.lastSeq ?? 0)]
            )
        ];

        if (snapshot?.lastErrorCode !== undefined) {
            summaryLines.push(`lastError=${snapshot.lastErrorCode}`);
        }

        return makeBox(state, "instances", entry.name, {
            detailLines: [
                formatField("Name", entry.name),
                formatField("Enabled", entry.enabled ? "yes" : "no"),
                formatField("Provider", entry.provider ?? "unknown"),
                formatField("Workspace", entry.defaultWorkspace ?? "unavailable"),
                formatField("Daemon", snapshot?.daemonState ?? "unknown"),
                formatField("Connect", snapshot?.connectionState ?? "unknown"),
                formatField("Ready", snapshot?.ready === true ? "yes" : "no"),
                formatField("Status", snapshot?.status ?? "unknown"),
                formatField("MCP", entry.mcpEnabled === true ? "enabled" : "disabled"),
                formatField("Approvals", String(approvals.length)),
                formatField("Logs", String(logs.length)),
                formatField("Last Seq", String(state.lastSeqByInstance[entry.name] ?? snapshot?.lastSeq ?? 0))
            ],
            id: `instance-${entry.name}`,
            status,
            summaryLines,
            title: entry.name
        });
    });
}
