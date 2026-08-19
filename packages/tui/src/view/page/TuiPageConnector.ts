import { CONTROL_WEB_BASE_PATH, controlWebBasePath, defaultMcpToolGroups, type JsonValue } from "@portable-devshell/shared";

import type { BoxModel } from "../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import { compactSummary, makeBox } from "./TuiPageBoxSupport.js";
import { asRecord, editorDraft, readPath } from "../../state/editor/TuiEditorDraft.js";
import { buttonLine, choiceLine, editorErrorLine, fieldLine, secretFieldLine } from "../editor/TuiEditorView.js";

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
    const localEndpoint = localMcpEndpoint(mcpDraft, readPath(instanceDraft, "mcp.path"), instanceName);
    const webEndpoint = webUiEndpoint(webDraft);
    const runtime = runtimeStatus(state, instanceDraft, mcpDraft, endpoint);
    const authMode = readPath(instanceDraft, "mcp.auth");
    const webAuthMode = readPath(webDraft, "auth");

    return [
        makeBox(state, "connections", instanceName, {
            detailLines: [
                `Local MCP          ${localEndpoint.value}`,
                `Public MCP         ${endpoint.value.replace(/^endpoint=/, "")}`,
                `Web UI             ${webEndpoint.value}`,
                `Runtime            ${runtime.runtime}`,
                `Auth               ${String(authMode ?? "none")}`,
                ...(runtime.reason === "ready" ? [] : [`Runtime reason     ${runtime.reason}`]),
                ...(localEndpoint.reason === undefined ? [] : [`Local reason       ${localEndpoint.reason}`]),
                ...(endpoint.reason === undefined ? [] : [`Public reason      ${endpoint.reason}`]),
                ...(webEndpoint.reason === undefined ? [] : [`Web reason         ${webEndpoint.reason}`]),
            ],
            id: "connection-endpoints",
            status: runtime.runtime === "running" ? "ready" : runtime.runtime === "disabled" ? "disabled" : "warning",
            summaryLines: [
                `local=${localEndpoint.value}`,
                `public=${endpoint.value.replace(/^endpoint=/, "")}`,
            ],
            title: "Connection Endpoints",
        }),
        makeBox(state, "connections", instanceName, {
            detailLines: [
                choiceLine("instance.mcp.enabled", "mcp.enabled", readPath(instanceDraft, "mcp.enabled")),
                fieldLine("instance.mcp.path", "mcp.path", readPath(instanceDraft, "mcp.path")),
                ...editorErrorLine(state, "connector", "mcp-endpoint", ["mcp"]),
            ],
            id: "mcp-endpoint",
            status: "normal",
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
                choiceLine("web.enabled", "enabled", readPath(webDraft, "enabled")),
                choiceLine("web.auth", "auth", webAuthMode),
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
                choiceLine("mcp.auth", "mcp.auth", authMode),
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
                ...editorErrorLine(state, "connector", "connector-actions", []),
                buttonLine("save", "Save", !instanceDirty && !globalDirty && !webDirty),
                buttonLine("cancel", "Cancel", !instanceDirty && !globalDirty && !webDirty),
                buttonLine("restart-control", "Restart Control", !state.ui.controlRestartRequired)
            ],
            id: "connector-actions",
            status: state.interaction.editor?.kind === "connector" && state.interaction.editor.error !== undefined
                ? "failed"
                : instanceDirty || globalDirty || webDirty
                  ? "warning"
                  : "normal",
            summaryLines: [compactSummary(["scopes", affectedScopes], ["dirty", instanceDirty || globalDirty || webDirty ? "yes" : "no"])],
            title: "Page Actions"
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

function localMcpEndpoint(
    mcp: Record<string, JsonValue>,
    configuredPath: JsonValue | undefined,
    instanceName: string,
): { reason?: string; value: string } {
    const host = readPath(mcp, "listenHost");
    const port = readPath(mcp, "listenPort");
    if (typeof host !== "string" || typeof port !== "number" || !Number.isInteger(port) || port < 1) {
        return { reason: "listener host/port unavailable", value: "unavailable" };
    }
    const localHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    const authority = localHost.includes(":") ? `[${localHost}]` : localHost;
    const path = typeof configuredPath === "string" && configuredPath.length > 0 ? configuredPath : `/${instanceName}/mcp`;
    return { value: `http://${authority}:${port}${path.startsWith("/") ? path : `/${path}`}` };
}

function webUiEndpoint(web: Record<string, JsonValue>): { reason?: string; value: string } {
    const disabled = readPath(web, "enabled") !== true;
    const publicBaseUrl = readPath(web, "publicBaseUrl");
    if (typeof publicBaseUrl === "string" && publicBaseUrl.length > 0) {
        try {
            const base = new URL(publicBaseUrl);
            const value = new URL(controlWebBasePath(publicBaseUrl), base.origin).toString().replace(/\/$/u, "");
            return { ...(disabled ? { reason: "Web UI is disabled" } : {}), value };
        } catch {
            return { reason: "invalid web.publicBaseUrl", value: "unavailable" };
        }
    }
    const host = readPath(web, "listenHost");
    const port = readPath(web, "listenPort");
    if (typeof host !== "string" || typeof port !== "number" || !Number.isInteger(port) || port < 1) {
        return { reason: "listener host/port unavailable", value: "unavailable" };
    }
    const localHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    const authority = localHost.includes(":") ? `[${localHost}]` : localHost;
    return {
        ...(disabled ? { reason: "Web UI is disabled" } : {}),
        value: `http://${authority}:${port}${CONTROL_WEB_BASE_PATH}`,
    };
}

function selectedInstanceDraft(state: TuiAppState, instanceName: string): Record<string, JsonValue> {
    const entry = Array.isArray(state.readModel.configView?.instances)
        ? state.readModel.configView.instances.find((value) => asRecord(value)?.name === instanceName)
        : undefined;
    return asRecord(entry) ?? { mcp: { auth: "none", enabled: true, path: `/${instanceName}/mcp`, tools: { capabilities: ["read", "write", "execute"], groups: [...defaultMcpToolGroups] } }, name: instanceName };
}

function globalMcpDraft(state: TuiAppState): Record<string, JsonValue> {
    return asRecord(state.readModel.configView?.mcp) ?? { enabled: false, listenHost: "127.0.0.1", listenPort: 0 };
}

function globalWebDraft(state: TuiAppState): Record<string, JsonValue> {
    return asRecord(state.readModel.configView?.web) ?? {
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

function runtimeStatus(
    state: TuiAppState,
    instance: Record<string, JsonValue>,
    mcp: Record<string, JsonValue>,
    endpoint: { reason?: string; value: string }
): { reason: string; runtime: string } {
    if (readPath(instance, "mcp.enabled") !== true || readPath(mcp, "enabled") !== true) {
        return { reason: "MCP is disabled", runtime: "disabled" };
    }
    const status = state.readModel.mcpStatus;
    if (status?.running !== true) {
        return { reason: typeof status?.reason === "string" ? status.reason : "MCP host is not listening", runtime: "stopped" };
    }
    if (status.authMode === "oauth2" && status.oauthReady !== true) {
        return { reason: "OAuth runtime is not ready", runtime: "running" };
    }
    if (endpoint.reason !== undefined) {
        return { reason: endpoint.reason, runtime: "running" };
    }
    return { reason: "ready", runtime: "running" };
}
