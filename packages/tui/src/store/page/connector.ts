import type { JsonValue } from "@portable-devshell/shared";

import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState } from "../TuiReducers.js";
import { compactSummary, makeBox } from "./PageBoxSupport.js";
import { asRecord, buttonLine, editorDraft, editorErrorLine, fieldLine, readPath } from "./EditorSupport.js";

export function buildConnectorPageBoxes(state: TuiAppState, instanceName: string): BoxModel[] {
    const instanceDraft = editorDraft(state, `config:${instanceName}`, selectedInstanceDraft(state, instanceName));
    const mcpDraft = editorDraft(state, `connector:${instanceName}`, globalMcpDraft(state));
    const unsaved = state.ui.dirtyForms[`connector:${instanceName}`] === true || state.ui.dirtyForms[`config:${instanceName}`] === true ? " [UNSAVED]" : "";
    const actions = [buttonLine("save", "Save"), buttonLine("cancel", "Cancel")];
    const endpoint = endpointPreview(mcpDraft, readPath(instanceDraft, "mcp.path"), instanceName);
    const authNonePublic = isPublic(mcpDraft) && readPath(mcpDraft, "auth.mode") === "none";

    return [
        makeBox(state, "connector", instanceName, {
            detailLines: [
                fieldLine("instance.mcp.enabled", "mcp.enabled", readPath(instanceDraft, "mcp.enabled")),
                fieldLine("instance.mcp.path", "mcp.path", readPath(instanceDraft, "mcp.path")),
                fieldLine("instance.mcp.allowTools", "allowTools", readPath(instanceDraft, "mcp.allowTools")),
                ...editorErrorLine(state, "connector", "mcp-endpoint", ["mcp", "allowTools"]),
                "runtime=notAvailable",
                "reason=control does not expose runtime readiness",
                ...actions
            ],
            id: "mcp-endpoint",
            status: readPath(instanceDraft, "mcp.enabled") === true ? "warning" : "disabled",
            summaryLines: [compactSummary(["enabled", String(readPath(instanceDraft, "mcp.enabled") ?? false)], ["path", String(readPath(instanceDraft, "mcp.path") ?? "-")])],
            title: `MCP Endpoint${unsaved}`
        }),
        makeBox(state, "connector", instanceName, {
            detailLines: [
                fieldLine("listenHost", "listenHost", readPath(mcpDraft, "listenHost")),
                fieldLine("listenPort", "listenPort", readPath(mcpDraft, "listenPort")),
                fieldLine("publicBaseUrl", "publicBaseUrl", readPath(mcpDraft, "publicBaseUrl")),
                ...editorErrorLine(state, "connector", "public-base-url", ["listenHost", "listenPort", "publicBaseUrl"]),
                ...actions
            ],
            id: "public-base-url",
            summaryLines: [compactSummary(["host", String(readPath(mcpDraft, "listenHost") ?? "-")], ["baseUrl", String(readPath(mcpDraft, "publicBaseUrl") ?? "-")])],
            title: `Public Base URL${unsaved}`
        }),
        makeBox(state, "connector", instanceName, {
            detailLines: [
                fieldLine("auth.mode", "auth.mode", readPath(mcpDraft, "auth.mode")),
                ...(authNonePublic ? [{ id: "auth-warning", text: "auth.mode=none is not valid for a public endpoint", tone: "danger" as const }] : []),
                ...editorErrorLine(state, "connector", "auth", ["auth"]),
                ...actions
            ],
            id: "auth",
            status: authNonePublic ? "failed" : "normal",
            summaryLines: [compactSummary(["mode", String(readPath(mcpDraft, "auth.mode") ?? "-")], ["public", isPublic(mcpDraft) ? "yes" : "no"])],
            title: `Auth${unsaved}`
        }),
        makeBox(state, "connector", instanceName, {
            detailLines: [endpoint.value, ...(endpoint.reason === undefined ? [] : [`reason=${endpoint.reason}`])],
            id: "endpoint-preview",
            status: endpoint.reason === undefined ? "normal" : "warning",
            summaryLines: [endpoint.value, ...(endpoint.reason === undefined ? [] : [`reason=${endpoint.reason}`])],
            title: "Endpoint Preview"
        }),
        makeBox(state, "connector", instanceName, {
            detailLines: authNonePublic
                ? ["validator error: auth.mode=none cannot expose a non-local endpoint"]
                : ["validation=available before save"],
            id: "validation",
            status: authNonePublic ? "failed" : "normal",
            summaryLines: [compactSummary(["publicAuth", authNonePublic ? "invalid" : "valid"])],
            title: "Validation"
        })
    ];
}

function selectedInstanceDraft(state: TuiAppState, instanceName: string): Record<string, JsonValue> {
    const entry = Array.isArray(state.configView?.instances)
        ? state.configView.instances.find((value) => asRecord(value)?.name === instanceName)
        : undefined;
    return asRecord(entry) ?? { mcp: { allowTools: [], enabled: true, path: `/${instanceName}/mcp` }, name: instanceName };
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
