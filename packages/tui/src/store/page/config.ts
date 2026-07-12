import type { JsonValue } from "@portable-devshell/shared";

import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState } from "../TuiReducers.js";
import { buildSelectedInstancePageContext, compactSummary, makeBox, shortenPath } from "./PageBoxSupport.js";
import { asRecord, buttonLine, choiceLine, editorDraft, editorErrorLine, fieldLine, readPath } from "./EditorSupport.js";

export function buildConfigPageBoxes(state: TuiAppState, instanceName: string): BoxModel[] {
    const { instance, snapshot } = buildSelectedInstancePageContext(state, instanceName);
    const fallback = instanceDraft(state, instanceName);
    const draft = editorDraft(state, `config:${instanceName}`, fallback);
    const dirty = state.ui.dirtyForms[`config:${instanceName}`] === true;
    const unsaved = dirty ? " [UNSAVED]" : "";
    const restartRequired = requiresRestart(fallback, draft);
    const running = snapshot?.daemonState === "running" || snapshot?.ready === true;

    return [
        makeBox(state, "config", instanceName, {
            detailLines: [
                "Instance configuration",
                choiceLine("provider", "provider", readPath(draft, "provider")),
                fieldLine("workspace", "defaultWorkspace", readPath(draft, "workspace")),
                "",
                "Security",
                choiceLine("security.mode", "security.mode", readPath(draft, "security.mode")),
                choiceLine("approvalPolicy.mode", "approvalPolicy.mode", readPath(draft, "approvalPolicy.mode")),
                "",
                "Logs",
                fieldLine("logs.retentionDays", "retentionDays", readPath(draft, "logs.retentionDays")),
                fieldLine("logs.eventBufferSize", "eventBufferSize", readPath(draft, "logs.eventBufferSize")),
                ...editorErrorLine(state, "config", "configuration", ["provider", "workspace", "security", "approvalPolicy", "logs"]),
                "",
                `Apply mode          ${restartRequired ? "restart required" : "hot apply"}`,
                ...(restartRequired && running ? ["Save Only is unavailable until the instance is stopped."] : []),
                "",
                "Actions",
                buttonLine("reload", "Reload"),
                buttonLine("save", "Save Only", restartRequired && running),
                buttonLine("save-restart", "Save & Restart", !running),
                buttonLine("cancel", "Cancel"),
                buttonLine("delete", "Delete")
            ],
            id: "configuration",
            status: dirty ? "warning" : instance?.enabled === false ? "disabled" : "normal",
            summaryLines: [
                compactSummary(
                    ["provider", stringValue(readPath(draft, "provider"), "unknown")],
                    ["workspace", shortenPath(stringValue(readPath(draft, "workspace"), "unavailable"))],
                    ["apply", restartRequired ? "restart" : "hot"]
                )
            ],
            title: `Configuration${unsaved}`
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
        mcp: { enabled: true, path: `/${instanceName}/mcp`, tools: { capabilities: ["read", "write", "execute"], groups: ["file", "bash", "artifact", "tmux", "todo"] } },
        name: instanceName,
        provider: "local",
        security: { mode: "disabled" },
        workspace: ""
    };
}

function requiresRestart(previous: Record<string, JsonValue>, next: Record<string, JsonValue>): boolean {
    return ["provider", "ssh", "container", "dockerBinary", "podmanBinary", "logs"].some(
        (path) => JSON.stringify(readPath(previous, path)) !== JSON.stringify(readPath(next, path))
    );
}

function stringValue(value: JsonValue | undefined, fallback: string): string {
    return value === undefined ? fallback : String(value);
}
