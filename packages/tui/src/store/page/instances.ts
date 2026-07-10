import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState } from "../TuiReducers.js";
import { compactSummary, formatField, makeBox, renderApprovalLine, runtimeStatus } from "./PageBoxSupport.js";

export function buildInstancesPageBoxes(state: TuiAppState, instanceName: string): BoxModel[] {
    const entry = state.instances.find((candidate) => candidate.name === instanceName);

    if (entry === undefined) {
        return [
            makeBox(state, "instances", instanceName, {
                detailLines: [`Instance ${instanceName} is no longer available from control.listInstances.`],
                id: "instances-empty",
                status: "warning",
                summaryLines: ["instance unavailable"],
                title: "Selected Instance"
            })
        ];
    }

    const snapshot = state.snapshotsByInstance[entry.name];
    const logs = state.logsByInstance[entry.name] ?? [];
    const approvals = (state.approvalsByInstance[entry.name] ?? []).filter((approval) => approval.status === "pending");
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

    return [
        makeBox(state, "instances", entry.name, {
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
            id: "instance-status",
            status: entry.enabled ? runtimeStatus(snapshot) : "disabled",
            summaryLines,
            title: entry.name
        }),
        ...(approvals.length === 0
            ? [
                  makeBox(state, "instances", entry.name, {
                      detailLines: ["No pending approvals from instance.listApprovals."],
                      id: "approvals-empty",
                      status: "normal",
                      summaryLines: ["pending=0"],
                      title: "Approvals"
                  })
              ]
            : approvals.map((approval) =>
                  makeBox(state, "instances", entry.name, {
                      detailLines: [
                          formatField("Approval", approval.approvalId),
                          formatField("Tool", approval.toolName),
                          formatField("Risk", approval.riskLevel),
                          formatField("Reason", approval.reason),
                          formatField("Input", approval.inputSummary),
                          formatField("Expires", approval.expiresAt),
                          { id: `approval.action:${approval.approvalId}`, text: "Open approval actions." }
                      ],
                      id: `approval-${approval.approvalId}`,
                      status: "pending",
                      summaryLines: [renderApprovalLine(approval), "Enter opens detail; it never approves directly."],
                      title: "Approval"
                  })
              ))
    ];
}
