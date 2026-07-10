import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState } from "../TuiReducers.js";
import { compactSummary, formatField, makeBox, runtimeStatus } from "./PageBoxSupport.js";

export function buildInstancesPageBoxes(state: TuiAppState): BoxModel[] {
    return [
        makeBox(state, "instances", undefined, {
            detailLines: ["Creation is not available in this stage."],
            disabled: true,
            id: "create-instance",
            status: "normal",
            summaryLines: ["new entry unavailable"],
            title: "Create Instance"
        }),
        ...state.instances.map((entry) => {
            const snapshot = state.snapshotsByInstance[entry.name];
            const approvals = (state.approvalsByInstance[entry.name] ?? []).filter((approval) => approval.status === "pending");
            const summaryLines = [
                compactSummary(
                    ["provider", entry.provider ?? "unknown"],
                    ["daemon", snapshot?.daemonState ?? "unknown"],
                    ["rpc", snapshot?.connectionState ?? "unknown"],
                    ["ready", snapshot?.ready === true ? "yes" : "no"]
                )
            ];

            if (snapshot?.lastErrorCode !== undefined) {
                summaryLines.push(`lastError=${snapshot.lastErrorCode}`);
            }

            return makeBox(state, "instances", entry.name, {
                detailLines: [
                    formatField("enabled", entry.enabled ? "yes" : "no"),
                    formatField("provider", entry.provider ?? "unknown"),
                    formatField("workspace", entry.defaultWorkspace ?? "-"),
                    formatField("daemonState", snapshot?.daemonState ?? "unknown"),
                    formatField("connectionState", snapshot?.connectionState ?? "unknown"),
                    formatField("ready", snapshot?.ready === true ? "true" : "false"),
                    formatField("pendingApprovals", String(approvals.length)),
                    formatField("lastError", snapshot?.lastErrorCode ?? "-"),
                    "",
                    "Actions",
                    { id: `instance.attachShell:${entry.name}`, text: "Attach Shell      unmanaged local shell" }
                ],
                expandedKey: `instances:${entry.name}:instance`,
                id: `instance:${entry.name}`,
                status: entry.enabled ? runtimeStatus(snapshot) : "disabled",
                summaryLines,
                title: entry.name
            });
        })
    ];
}
