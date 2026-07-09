import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState } from "../TuiReducers.js";
import { buildSelectedInstancePageContext, compactSummary, makeBox, shortenPath } from "./PageBoxSupport.js";

export function buildConfigPageBoxes(state: TuiAppState, instanceName: string): BoxModel[] {
    const { approvals, instance, logs, snapshot } = buildSelectedInstancePageContext(state, instanceName);

    return [
        makeBox(state, "config", instanceName, {
            detailLines: [`provider ${instance?.provider ?? "unknown"}`],
            id: "provider",
            summaryLines: [compactSummary(["provider", instance?.provider ?? "unknown"])],
            title: "Provider"
        }),
        makeBox(state, "config", instanceName, {
            detailLines: [`workspace ${instance?.defaultWorkspace ?? "unavailable"}`],
            id: "workspace",
            summaryLines: [compactSummary(["workspace", shortenPath(instance?.defaultWorkspace ?? "unavailable")])],
            title: "Workspace"
        }),
        makeBox(state, "config", instanceName, {
            detailLines: [`enabled ${instance?.mcpEnabled === true ? "true" : "false"}`, `path ${instance?.mcpPath ?? "unavailable"}`],
            id: "mcp-config",
            status: instance?.mcpEnabled === true ? "ready" : "disabled",
            summaryLines: [compactSummary(["enabled", instance?.mcpEnabled === true ? "true" : "false"], ["path", shortenPath(instance?.mcpPath ?? "unavailable")])],
            title: "MCP"
        }),
        makeBox(state, "config", instanceName, {
            detailLines: [`lastErrorCode ${snapshot?.lastErrorCode ?? "none"}`, `connectionState ${snapshot?.connectionState ?? "unknown"}`],
            id: "security",
            status: snapshot?.lastErrorCode === undefined ? "normal" : "warning",
            summaryLines: [compactSummary(["lastError", snapshot?.lastErrorCode ?? "none"], ["connection", snapshot?.connectionState ?? "unknown"])],
            title: "Security"
        }),
        makeBox(state, "config", instanceName, {
            detailLines: approvals.length === 0 ? ["pending approvals none"] : approvals.slice(0, 6).map((approval) => `${approval.toolName} ${approval.approvalId} ${approval.riskLevel}`),
            id: "approval-policy",
            status: approvals.length > 0 ? "pending" : "normal",
            summaryLines: [compactSummary(["pending", String(approvals.length)], ["mode", "readonly"])],
            title: "Approval Policy"
        }),
        makeBox(state, "config", instanceName, {
            detailLines: ["source instance.readLogs + log.appended", `cached ${logs.length}`],
            id: "logs-policy",
            summaryLines: [compactSummary(["source", "instance.readLogs"], ["cached", String(logs.length)])],
            title: "Logs Policy"
        })
    ];
}
