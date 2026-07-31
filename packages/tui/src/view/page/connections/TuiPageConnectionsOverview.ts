import type { JsonValue } from "@portable-devshell/shared";

import type { BoxModel } from "../../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import { compactSummary, formatField, makeBox } from "../TuiPageBoxSupport.js";

export function buildConnectionsOverviewBoxes(state: TuiAppState, instance: string): BoxModel[] {
    const entry = state.instances.find((candidate) => candidate.name === instance);
    const mcp = asRecord(state.configView?.mcp);
    const auth = asRecord(mcp?.auth);
    const authMode = typeof auth?.mode === "string" ? auth.mode : "none";
    const running = state.mcpStatus?.running === true;
    const pendingOAuth = state.oauthApprovals.filter((approval) => approval.status === "pending").length;
    const snapshot = state.snapshotsByInstance[instance];

    return [
        makeBox(state, "connections", instance, {
            detailLines: [
                formatField("Enabled", String(entry?.mcpEnabled ?? false)),
                formatField("Path", entry?.mcpPath ?? `/${instance}/mcp`),
                formatField("Runtime", running ? "running" : "stopped"),
                formatField("Public URL", typeof mcp?.publicBaseUrl === "string" ? mcp.publicBaseUrl : "-")
            ],
            id: "connections:connector:mcp",
            primaryRoute: { connectorId: "mcp", page: "connections", view: "connector" },
            status: running ? "ready" : entry?.mcpEnabled === false ? "disabled" : "warning",
            summaryLines: [compactSummary(["runtime", running ? "running" : "stopped"], ["path", entry?.mcpPath ?? `/${instance}/mcp`])],
            title: "Connector"
        }),
        makeBox(state, "connections", instance, {
            detailLines: [
                formatField("Provider", authMode),
                formatField("Ready", String(state.mcpStatus?.oauthReady === true)),
                formatField("Pending", String(pendingOAuth))
            ],
            id: "connections:oauth:default",
            primaryRoute: { page: "connections", providerId: "default", view: "oauth" },
            status: authMode !== "oauth2" ? "disabled" : state.mcpStatus?.oauthReady === true ? "ready" : "failed",
            summaryLines: [compactSummary(["provider", authMode], ["pending", String(pendingOAuth)])],
            title: "OAuth Provider"
        }),
        makeBox(state, "connections", instance, {
            detailLines: [
                formatField("Provider", entry?.provider ?? "unknown"),
                formatField("Connection", snapshot?.connectionState ?? "unknown"),
                formatField("Daemon", snapshot?.daemonState ?? "unknown")
            ],
            id: `connections:reverse:${instance}`,
            primaryRoute: { instanceId: instance, page: "connections", view: "reverse" },
            status: snapshot?.connectionState === "connected" ? "ready" : "warning",
            summaryLines: [compactSummary(["connection", snapshot?.connectionState ?? "unknown"], ["provider", entry?.provider ?? "unknown"])],
            title: "Reverse Connection"
        })
    ];
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
