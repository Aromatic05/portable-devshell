import type { JsonValue } from "@portable-devshell/shared";

import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState } from "../TuiReducers.js";
import { compactSummary, makeBox } from "./PageBoxSupport.js";
import { asRecord, buttonLine, editorDraft, editorErrorLine, fieldLine, readPath } from "./EditorSupport.js";

export function buildConnectorPageBoxes(state: TuiAppState, instanceName: string): BoxModel[] {
    const instanceDraft = editorDraft(state, `config:${instanceName}`, selectedInstanceDraft(state, instanceName));
    const mcpDraft = editorDraft(state, `connector:${instanceName}`, globalMcpDraft(state));
    const unsaved = state.ui.dirtyForms[`connector:${instanceName}`] === true || state.ui.dirtyForms[`config:${instanceName}`] === true ? " [UNSAVED]" : "";
    const instanceDirty = state.ui.dirtyForms[`config:${instanceName}`] === true;
    const globalDirty = state.ui.dirtyForms[`connector:${instanceName}`] === true;
    const affectedScopes = [instanceDirty ? "instance" : undefined, globalDirty ? "global" : undefined].filter(Boolean).join(" + ") || "none";
    const endpoint = endpointPreview(mcpDraft, readPath(instanceDraft, "mcp.path"), instanceName);
    const runtime = runtimeStatus(state, instanceDraft, mcpDraft, endpoint);
    const authNonePublic = isPublic(mcpDraft) && readPath(mcpDraft, "auth.mode") === "none";

    return [
        makeBox(state, "connector", instanceName, {
            detailLines: [
                fieldLine("instance.mcp.enabled", "mcp.enabled", readPath(instanceDraft, "mcp.enabled")),
                fieldLine("instance.mcp.path", "mcp.path", readPath(instanceDraft, "mcp.path")),
                fieldLine("instance.mcp.tools.groups", "groups", readPath(instanceDraft, "mcp.tools.groups")),
                fieldLine("instance.mcp.tools.capabilities", "capabilities", readPath(instanceDraft, "mcp.tools.capabilities")),
                ...editorErrorLine(state, "connector", "mcp-endpoint", ["mcp", "tools"]),
                `MCP runtime        ${runtime.runtime}`,
                `Public endpoint    ${runtime.publicEndpoint}`,
                `Reason             ${runtime.reason}`
            ],
            id: "mcp-endpoint",
            status: runtime.runtime === "running" ? "ready" : runtime.runtime === "disabled" ? "disabled" : "failed",
            summaryLines: [compactSummary(["enabled", String(readPath(instanceDraft, "mcp.enabled") ?? false)], ["path", String(readPath(instanceDraft, "mcp.path") ?? "-")])],
            title: `[Instance] MCP Endpoint${unsaved}`
        }),
        makeBox(state, "connector", instanceName, {
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
        makeBox(state, "connector", instanceName, {
            detailLines: [
                fieldLine("auth.mode", "auth.mode", readPath(mcpDraft, "auth.mode")),
                ...(authNonePublic ? [{ id: "auth-warning", text: "auth.mode=none is not valid for a public endpoint", tone: "danger" as const }] : []),
                ...editorErrorLine(state, "connector", "auth", ["auth"])
            ],
            id: "auth",
            status: authNonePublic ? "failed" : "normal",
            summaryLines: [compactSummary(["mode", String(readPath(mcpDraft, "auth.mode") ?? "-")], ["public", isPublic(mcpDraft) ? "yes" : "no"])],
            title: `[Global] Auth${unsaved}`
        }),
        makeBox(state, "connector", instanceName, {
            detailLines: [
                `Affected scopes    ${affectedScopes}`,
                `Instance changes   ${instanceDirty ? "yes" : "no"}`,
                `Global changes     ${globalDirty ? "yes" : "no"}`,
                buttonLine("save", "Save", !instanceDirty && !globalDirty),
                buttonLine("cancel", "Cancel", !instanceDirty && !globalDirty),
                buttonLine("restart-control", "Restart Control", !state.ui.controlRestartRequired)
            ],
            id: "connector-actions",
            status: instanceDirty || globalDirty ? "warning" : "normal",
            summaryLines: [compactSummary(["scopes", affectedScopes], ["dirty", instanceDirty || globalDirty ? "yes" : "no"])],
            title: "Page Actions"
        }),
        makeBox(state, "connector", instanceName, {
            detailLines: [endpoint.value, ...(endpoint.reason === undefined ? [] : [`reason=${endpoint.reason}`])],
            id: "endpoint-preview",
            status: endpoint.reason === undefined ? "normal" : "warning",
            summaryLines: [endpoint.value, ...(endpoint.reason === undefined ? [] : [`reason=${endpoint.reason}`])],
            title: "Configured Endpoint"
        }),
        makeBox(state, "connector", instanceName, {
            detailLines: authNonePublic
                ? ["validator error: auth.mode=none cannot expose a non-local endpoint"]
                : ["validation=available before save"],
            id: "validation",
            status: authNonePublic ? "failed" : "normal",
            summaryLines: [compactSummary(["publicAuth", authNonePublic ? "invalid" : "valid"])],
            title: "Configuration Validation"
        })
    ];
}

function selectedInstanceDraft(state: TuiAppState, instanceName: string): Record<string, JsonValue> {
    const entry = Array.isArray(state.configView?.instances)
        ? state.configView.instances.find((value) => asRecord(value)?.name === instanceName)
        : undefined;
    return asRecord(entry) ?? { mcp: { enabled: true, path: `/${instanceName}/mcp`, tools: { capabilities: ["read", "write", "execute"], groups: ["file", "bash", "artifact", "tmux"] } }, name: instanceName };
}

function globalMcpDraft(state: TuiAppState): Record<string, JsonValue> {
    return asRecord(state.configView?.mcp) ?? { auth: { mode: "none" }, enabled: false, listenHost: "127.0.0.1", listenPort: 0 };
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
