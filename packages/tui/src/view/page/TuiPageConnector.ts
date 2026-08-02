import { defaultMcpToolGroups, type JsonValue } from "@portable-devshell/shared";

import type { BoxModel } from "../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import { compactSummary, makeBox } from "./TuiPageBoxSupport.js";
import { asRecord, editorDraft, readPath } from "../../state/editor/TuiEditorDraft.js";
import { buttonLine, editorErrorLine, fieldLine, secretFieldLine } from "../editor/TuiEditorView.js";

export function buildConnectorPageBoxes(state: TuiAppState, instanceName: string): BoxModel[] {
    const instanceDraft = editorDraft(state, `config:${instanceName}`, selectedInstanceDraft(state, instanceName));
    const mcpDraft = editorDraft(state, "connector", globalMcpDraft(state));
    const webDraft = editorDraft(state, "web", globalWebDraft(state));
    const unsaved = state.ui.dirtyForms["connector"] === true || state.ui.dirtyForms[`config:${instanceName}`] === true || state.ui.dirtyForms["web"] === true ? " [UNSAVED]" : "";
    const instanceDirty = state.ui.dirtyForms[`config:${instanceName}`] === true;
    const globalDirty = state.ui.dirtyForms["connector"] === true;
    const webDirty = state.ui.dirtyForms["web"] === true;
    const affectedScopes = [instanceDirty ? "instance" : undefined, globalDirty ? "mcp" : undefined, webDirty ? "web" : undefined].filter(Boolean).join(" + ") || "none";
    const endpoint = endpointPreview(mcpDraft, readPath(instanceDraft, "mcp.path"), instanceName);
    const runtime = runtimeStatus(state, instanceDraft, mcpDraft, endpoint);
    const authMode = readPath(instanceDraft, "mcp.auth");
    const webAuthMode = readPath(webDraft, "auth");

    return [
        makeBox(state, "connections", instanceName, {
            detailLines: [
                fieldLine("instance.mcp.enabled", "mcp.enabled", readPath(instanceDraft, "mcp.enabled")),
                fieldLine("instance.mcp.path", "mcp.path", readPath(instanceDraft, "mcp.path")),
                ...editorErrorLine(state, "connector", "mcp-endpoint", ["mcp"]),
                `MCP runtime        ${runtime.runtime}`,
                `Public endpoint    ${runtime.publicEndpoint}`,
                `Reason             ${runtime.reason}`
            ],
            id: "mcp-endpoint",
            status: runtime.runtime === "running" ? "ready" : runtime.runtime === "disabled" ? "disabled" : "failed",
            summaryLines: [compactSummary(["enabled", String(readPath(instanceDraft, "mcp.enabled") ?? false)], ["path", String(readPath(instanceDraft, "mcp.path") ?? "-")])],
            title: `[Instance] MCP Endpoint${unsaved}`
        }),
        makeBox(state, "connections", instanceName, {
            detailLines: [
                fieldLine("listenHost", "listenHost", readPath(mcpDraft, "listenHost")),
                fieldLine("listenPort", "listenPort", readPath(mcpDraft, "listenPort")),
                fieldLine("publicBaseUrl", "publicBaseUrl", readPath(mcpDraft, "publicBaseUrl")),
                ...editorErrorLine(state, "connector", "public-base-url", ["listenHost", "listenPort", "publicBaseUrl"])
            ],
            id: "public-base-url",
            summaryLines: [compactSummary(["host", String(readPath(mcpDraft, "listenHost") ?? "-")], ["baseUrl", String(readPath(mcpDraft, "publicBaseUrl") ?? "-")])],
            title: `[Global] Public Base URL${unsaved}`
        }),
        makeBox(state, "connections", instanceName, {
            detailLines: [
                fieldLine("web.enabled", "enabled", readPath(webDraft, "enabled")),
                fieldLine("web.auth", "auth", webAuthMode),
                ...(webAuthMode === "token"
                    ? [secretFieldLine("web.token", "token", readPath(webDraft, "token"))]
                    : []),
                ...(webAuthMode === "oauth2"
                    ? [
                        fieldLine("web.oauth2.resourceName", "resource", readPath(webDraft, "oauth2.resourceName")),
                        fieldLine("web.oauth2.requiredScopes", "scopes", readPath(webDraft, "oauth2.requiredScopes")),
                        fieldLine("web.oauth2.documentationUrl", "documentationUrl", readPath(webDraft, "oauth2.documentationUrl"))
                    ]
                    : []),
                fieldLine("web.listenHost", "listenHost", readPath(webDraft, "listenHost")),
                fieldLine("web.listenPort", "listenPort", readPath(webDraft, "listenPort")),
                fieldLine("web.publicBaseUrl", "publicBaseUrl", readPath(webDraft, "publicBaseUrl")),
                ...editorErrorLine(state, "connector", "web", ["web", "auth", "oauth2", "token"])
            ],
            id: "web",
            summaryLines: [compactSummary(["enabled", String(readPath(webDraft, "enabled") ?? false)], ["listener", `${String(readPath(webDraft, "listenHost") ?? "-")}:${String(readPath(webDraft, "listenPort") ?? "-")}`])],
            title: `[Global] Web UI${unsaved}`
        }),
        makeBox(state, "connections", instanceName, {
            detailLines: [
                fieldLine("mcp.auth", "mcp.auth", authMode),
                ...(authMode === "token"
                    ? [secretFieldLine("mcp.token", "mcp.token", readPath(instanceDraft, "mcp.token"))]
                    : []),
                ...(authMode === "oauth2"
                    ? [
                        fieldLine("mcp.oauth2.resourceName", "resource", readPath(instanceDraft, "mcp.oauth2.resourceName")),
                        fieldLine("mcp.oauth2.requiredScopes", "scopes", readPath(instanceDraft, "mcp.oauth2.requiredScopes"))
                    ]
                    : []),
                ...editorErrorLine(state, "connector", "auth", ["mcp", "auth", "oauth2", "token"])
            ],
            id: "auth",
            status: "normal",
            summaryLines: [compactSummary(["mode", String(authMode ?? "-")], ["namespace", instanceName])],
            title: `[Instance] Auth${unsaved}`
        }),
        makeBox(state, "connections", instanceName, {
            detailLines: [
                `Affected scopes    ${affectedScopes}`,
                `Instance changes   ${instanceDirty ? "yes" : "no"}`,
                `MCP changes        ${globalDirty ? "yes" : "no"}`,
                `Web changes        ${webDirty ? "yes" : "no"}`,
                buttonLine("save", "Save", !instanceDirty && !globalDirty && !webDirty),
                buttonLine("cancel", "Cancel", !instanceDirty && !globalDirty && !webDirty),
                buttonLine("restart-control", "Restart Control", !state.ui.controlRestartRequired)
            ],
            id: "connector-actions",
            status: instanceDirty || globalDirty || webDirty ? "warning" : "normal",
            summaryLines: [compactSummary(["scopes", affectedScopes], ["dirty", instanceDirty || globalDirty || webDirty ? "yes" : "no"])],
            title: "Page Actions"
        }),
        makeBox(state, "connections", instanceName, {
            detailLines: [endpoint.value, ...(endpoint.reason === undefined ? [] : [`reason=${endpoint.reason}`])],
            id: "endpoint-preview",
            status: endpoint.reason === undefined ? "normal" : "warning",
            summaryLines: [endpoint.value, ...(endpoint.reason === undefined ? [] : [`reason=${endpoint.reason}`])],
            title: "Configured Endpoint"
        }),
        makeBox(state, "connections", instanceName, {
            detailLines: ["validation=available before save"],
            id: "validation",
            status: "normal",
            summaryLines: [compactSummary(["namespaceAuth", "valid"])],
            title: "Configuration Validation"
        })
    ];
}

function selectedInstanceDraft(state: TuiAppState, instanceName: string): Record<string, JsonValue> {
    const entry = Array.isArray(state.configView?.instances)
        ? state.configView.instances.find((value) => asRecord(value)?.name === instanceName)
        : undefined;
    return asRecord(entry) ?? { mcp: { auth: "none", enabled: true, path: `/${instanceName}/mcp`, tools: { capabilities: ["read", "write", "execute"], groups: [...defaultMcpToolGroups] } }, name: instanceName };
}

function globalMcpDraft(state: TuiAppState): Record<string, JsonValue> {
    return asRecord(state.configView?.mcp) ?? { enabled: false, listenHost: "127.0.0.1", listenPort: 0 };
}

function globalWebDraft(state: TuiAppState): Record<string, JsonValue> {
    return asRecord(state.configView?.web) ?? {
        auth: "none", enabled: false, listenHost: "127.0.0.1", listenPort: 0
    };
}

function endpointPreview(mcp: Record<string, JsonValue>, configuredPath: JsonValue | undefined, instanceName: string): { reason?: string; value: string } {
    const publicBaseUrl = readPath(mcp, "publicBaseUrl");
    if (typeof publicBaseUrl !== "string" || publicBaseUrl.length === 0) {
        return { reason: "missing publicBaseUrl", value: "endpoint=unavailable" };
    }

    try {
        const baseUrl = new URL(publicBaseUrl);
        const path = typeof configuredPath === "string" && configuredPath.length > 0 ? configuredPath : `/${instanceName}/mcp`;
        const endpointPath = path.startsWith("/") ? path.slice(1) : path;
        const normalizedBaseUrl = baseUrl.toString().endsWith("/") ? baseUrl.toString().slice(0, -1) : baseUrl.toString();
        return { value: `endpoint=${new URL(endpointPath, `${normalizedBaseUrl}/`).toString()}` };
    } catch {
        return { reason: "invalid publicBaseUrl", value: "endpoint=unavailable" };
    }
}

function isPublic(mcp: Record<string, JsonValue>): boolean {
    const publicBaseUrl = readPath(mcp, "publicBaseUrl");
    const host = readPath(mcp, "listenHost");
    return (typeof publicBaseUrl === "string" && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(publicBaseUrl)) || host === "0.0.0.0";
}

function runtimeStatus(
    state: TuiAppState,
    instance: Record<string, JsonValue>,
    mcp: Record<string, JsonValue>,
    endpoint: { reason?: string; value: string }
): { publicEndpoint: string; reason: string; runtime: string } {
    if (readPath(instance, "mcp.enabled") !== true || readPath(mcp, "enabled") !== true) {
        return { publicEndpoint: "unavailable", reason: "MCP is disabled", runtime: "disabled" };
    }
    const status = state.mcpStatus;
    if (status?.running !== true) {
        return { publicEndpoint: "unavailable", reason: typeof status?.reason === "string" ? status.reason : "MCP host is not listening", runtime: "stopped" };
    }
    if (status.authMode === "oauth2" && status.oauthReady !== true) {
        return { publicEndpoint: "unavailable", reason: "OAuth runtime is not ready", runtime: "running" };
    }
    if (endpoint.reason !== undefined) {
        return { publicEndpoint: "unavailable", reason: endpoint.reason, runtime: "running" };
    }
    return { publicEndpoint: endpoint.value.replace(/^endpoint=/, ""), reason: "ready", runtime: "running" };
}
