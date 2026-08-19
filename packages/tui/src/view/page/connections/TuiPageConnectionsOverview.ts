import type { JsonValue } from "@portable-devshell/shared";

import type { BoxModel } from "../../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import { compactSummary, formatField, makeBox } from "../TuiPageBoxSupport.js";

export function buildConnectionsOverviewBoxes(state: TuiAppState, instance: string): BoxModel[] {
    const entry = state.instances.find((candidate) => candidate.name === instance);
    const mcp = asRecord(state.readModel.configView?.mcp);
    const auth = asRecord(mcp?.auth);
    const authMode = typeof auth?.mode === "string" ? auth.mode : "none";
    const running = state.readModel.mcpStatus?.running === true;
    const pendingOAuth = state.readModel.oauthApprovals.filter((approval) => approval.status === "pending").length;
    const snapshot = state.readModel.instanceState[instance]?.snapshot;
    const enabled = entry?.mcpEnabled === true;
    const runtime = !enabled ? "disabled" : running ? "running" : "stopped";
    const path = entry?.mcpPath ?? `/${instance}/mcp`;
    const publicEndpoint = running && enabled ? publicMcpEndpoint(mcp?.publicBaseUrl, path) : "unavailable";

    return [
        makeBox(state, "connections", instance, {
            detailLines: [
                formatField("Enabled", String(enabled)),
                formatField("Path", path),
                formatField("Runtime", runtime),
                formatField("Public MCP", publicEndpoint)
            ],
            id: "connections:connector:mcp",
            primaryRoute: { connectorId: "mcp", page: "connections", view: "connector" },
            status: running && enabled ? "ready" : !enabled ? "disabled" : "warning",
            summaryLines: [compactSummary(["runtime", runtime], ["path", path])],
            title: "Connector"
        }),
        makeBox(state, "connections", instance, {
            detailLines: [
                formatField("Provider", authMode),
                formatField("Ready", String(state.readModel.mcpStatus?.oauthReady === true)),
                formatField("Pending", String(pendingOAuth))
            ],
            id: "connections:oauth:default",
            primaryRoute: { page: "connections", providerId: "default", view: "oauth" },
            status: authMode !== "oauth2" ? "disabled" : state.readModel.mcpStatus?.oauthReady === true ? "ready" : "failed",
            summaryLines: [compactSummary(["provider", authMode], ["pending", String(pendingOAuth)])],
            title: "OAuth Provider"
        }),
        ...(entry?.provider === "reverse" ? [makeBox(state, "connections", instance, {
            detailLines: [
                formatField("Provider", entry.provider),
                formatField("Connection", snapshot?.connectionState ?? "unknown"),
                formatField("Daemon", snapshot?.daemonState ?? "unknown")
            ],
            id: `connections:reverse:${instance}`,
            primaryRoute: { instanceId: instance, page: "connections", view: "reverse" },
            status: snapshot?.connectionState === "connected" ? "ready" : "warning",
            summaryLines: [compactSummary(["connection", snapshot?.connectionState ?? "unknown"], ["provider", entry.provider])],
            title: "Reverse Connection"
        })] : [])
    ];
}

function publicMcpEndpoint(publicBaseUrl: JsonValue | undefined, path: string): string {
    if (typeof publicBaseUrl !== "string" || publicBaseUrl.length === 0) return "unavailable";
    try {
        const base = publicBaseUrl.endsWith("/") ? publicBaseUrl : `${publicBaseUrl}/`;
        return new URL(path.startsWith("/") ? path.slice(1) : path, base).toString();
    } catch {
        return "unavailable";
    }
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
