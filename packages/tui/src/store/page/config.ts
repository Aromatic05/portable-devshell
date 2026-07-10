import type { JsonValue } from "@portable-devshell/shared";

import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState } from "../TuiReducers.js";
import { buildSelectedInstancePageContext, compactSummary, makeBox, shortenPath } from "./PageBoxSupport.js";
import { asRecord, buttonLine, choiceLine, editorDraft, editorErrorLine, fieldLine, readPath } from "./EditorSupport.js";

export function buildConfigPageBoxes(state: TuiAppState, instanceName: string): BoxModel[] {
    const { instance } = buildSelectedInstancePageContext(state, instanceName);
    const fallback = instanceDraft(state, instanceName);
    const draft = editorDraft(state, `config:${instanceName}`, fallback);
    const unsaved = state.ui.dirtyForms[`config:${instanceName}`] === true ? " [UNSAVED]" : "";
    const actions = [buttonLine("save", "Save"), buttonLine("cancel", "Cancel")];

    return [
        makeBox(state, "config", instanceName, {
            detailLines: [choiceLine("provider", "provider", readPath(draft, "provider")), choiceLine("enabled", "enabled", readPath(draft, "enabled")), ...editorErrorLine(state, "config", "provider", ["provider", "enabled"]), ...actions],
            id: "provider",
            summaryLines: [compactSummary(["provider", stringValue(readPath(draft, "provider"), "unknown")], ["editable", "yes"])],
            title: `Provider${unsaved}`
        }),
        makeBox(state, "config", instanceName, {
            detailLines: [fieldLine("workspace", "defaultWorkspace", readPath(draft, "workspace")), ...editorErrorLine(state, "config", "workspace", ["workspace"]), ...actions],
            id: "workspace",
            summaryLines: [compactSummary(["workspace", shortenPath(stringValue(readPath(draft, "workspace"), "unavailable"))])],
            title: `Workspace${unsaved}`
        }),
        makeBox(state, "config", instanceName, {
            detailLines: [
                choiceLine("mcp.enabled", "mcp.enabled", readPath(draft, "mcp.enabled")),
                fieldLine("mcp.path", "mcp.path", readPath(draft, "mcp.path")),
                fieldLine("mcp.allowTools", "allowTools", readPath(draft, "mcp.allowTools")),
                ...editorErrorLine(state, "config", "mcp-config", ["mcp"]),
                ...actions
            ],
            id: "mcp-config",
            status: readPath(draft, "mcp.enabled") === true ? "ready" : "disabled",
            summaryLines: [compactSummary(["enabled", stringValue(readPath(draft, "mcp.enabled"), "false")], ["path", shortenPath(stringValue(readPath(draft, "mcp.path"), "-"))])],
            title: `MCP Config${unsaved}`
        }),
        makeBox(state, "config", instanceName, {
            detailLines: [choiceLine("security.mode", "security.mode", readPath(draft, "security.mode")), ...editorErrorLine(state, "config", "security", ["security"]), ...actions],
            id: "security",
            summaryLines: [compactSummary(["mode", stringValue(readPath(draft, "security.mode"), "disabled")])],
            title: `Security${unsaved}`
        }),
        makeBox(state, "config", instanceName, {
            detailLines: [choiceLine("approvalPolicy.mode", "approvalPolicy.mode", readPath(draft, "approvalPolicy.mode")), ...editorErrorLine(state, "config", "approval-policy", ["approvalPolicy"]), ...actions],
            id: "approval-policy",
            summaryLines: [compactSummary(["mode", stringValue(readPath(draft, "approvalPolicy.mode"), "default")])],
            title: `Approval Policy${unsaved}`
        }),
        makeBox(state, "config", instanceName, {
            detailLines: [
                fieldLine("logs.retentionDays", "retentionDays", readPath(draft, "logs.retentionDays")),
                fieldLine("logs.eventBufferSize", "eventBufferSize", readPath(draft, "logs.eventBufferSize")),
                ...editorErrorLine(state, "config", "logs-policy", ["logs", "retentionDays", "eventBufferSize"]),
                ...actions
            ],
            id: "logs-policy",
            summaryLines: [compactSummary(["retentionDays", stringValue(readPath(draft, "logs.retentionDays"), "-")], ["buffer", stringValue(readPath(draft, "logs.eventBufferSize"), "-")])],
            title: `Logs Policy${unsaved}`
        }),
        makeBox(state, "config", instanceName, {
            detailLines: [buttonLine("disable", "Disable"), buttonLine("delete", "Delete")],
            id: "danger-zone",
            status: instance?.enabled === false ? "disabled" : "warning",
            summaryLines: [compactSummary(["enabled", instance?.enabled === true ? "true" : "false"], ["actions", "disable,delete"])],
            title: "Danger Zone"
        })
    ];
}

function instanceDraft(state: TuiAppState, instanceName: string): Record<string, JsonValue> {
    const entries = state.configView?.instances;
    const existing = Array.isArray(entries)
        ? entries.find((entry) => asRecord(entry)?.name === instanceName)
        : undefined;
    const record = asRecord(existing);

    return record ?? {
        enabled: true,
        mcp: { allowTools: [], enabled: true, path: `/${instanceName}/mcp` },
        name: instanceName,
        provider: "local",
        security: { mode: "disabled" },
        workspace: ""
    };
}

function stringValue(value: JsonValue | undefined, fallback: string): string {
    return value === undefined ? fallback : String(value);
}
