import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState } from "../TuiReducers.js";
import { buildEndpointPreview, buildSelectedInstancePageContext, compactSummary, endpointAvailabilityLabel, makeBox, shortenPath } from "./PageBoxSupport.js";

export function buildConnectorPageBoxes(state: TuiAppState, instanceName: string): BoxModel[] {
    const { config, instance } = buildSelectedInstancePageContext(state, instanceName);

    return [
        makeBox(state, "connector", instanceName, {
            detailLines: [
                `mcp enabled ${instance?.mcpEnabled === true ? "true" : "false"}`,
                `mcp path ${instance?.mcpPath ?? "unavailable"}`,
                "Runtime readiness: not available in current control API"
            ],
            id: "mcp-runtime-config",
            status: instance?.mcpEnabled === true ? "warning" : "disabled",
            summaryLines: [compactSummary(["enabled", instance?.mcpEnabled === true ? "true" : "false"], ["path", shortenPath(instance?.mcpPath ?? "unavailable")]), "reason=no-runtime-api"],
            title: "MCP Runtime Config"
        }),
        makeBox(state, "connector", instanceName, {
            detailLines: [buildEndpointPreview(state, instanceName), "Runtime readiness: not available in current control API"],
            id: "endpoint-preview",
            status: "warning",
            summaryLines: [compactSummary(["endpoint", buildEndpointPreview(state, instanceName)]), "reason=preview-only"],
            title: "Endpoint Preview"
        }),
        makeBox(state, "connector", instanceName, {
            detailLines: [`auth.mode ${config?.authMode ?? "unavailable"}`, `publicBaseUrl ${config?.publicBaseUrl ?? "unavailable"}`],
            id: "auth-config",
            summaryLines: [compactSummary(["auth", config?.authMode ?? "unavailable"], ["baseUrl", config?.publicBaseUrl ?? "-"])],
            title: "Auth Config"
        }),
        makeBox(state, "connector", instanceName, {
            detailLines: [
                config?.publicBaseUrl === undefined ? "publicBaseUrl missing" : `publicBaseUrl ${config.publicBaseUrl}`,
                "Runtime readiness: not available in current control API"
            ],
            id: "public-availability-reason",
            status: "warning",
            summaryLines: [
                compactSummary(["endpoint", endpointAvailabilityLabel(config?.publicBaseUrl)]),
                config?.publicBaseUrl === undefined ? "reason=missing-publicBaseUrl" : "reason=no-runtime-api"
            ],
            title: "Public Availability Reason"
        })
    ];
}
