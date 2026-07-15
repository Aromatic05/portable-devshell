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
    const changes = draftDiff(fallback, draft);

    return [
        makeBox(state, "config", instanceName, {
            detailLines: [
                fieldLine("enabled", "enabled", readPath(draft, "enabled")),
                choiceLine("provider", "provider", readPath(draft, "provider")),
                fieldLine("workspace", "defaultWorkspace", readPath(draft, "workspace")),
                ...editorErrorLine(state, "config", "configuration", ["enabled", "provider", "workspace"])
            ],
            id: "configuration",
            status: configStatus(state, ["enabled", "provider", "workspace"], instance?.enabled === false ? "disabled" : "normal"),
            summaryLines: [
                compactSummary(
                    ["provider", stringValue(readPath(draft, "provider"), "unknown")],
                    ["workspace", shortenPath(stringValue(readPath(draft, "workspace"), "unavailable"))]
                )
            ],
            title: "General"
        }),
        makeBox(state, "config", instanceName, {
            detailLines: [
                ...providerLines(draft),
                ...editorErrorLine(state, "config", "provider", ["provider", "ssh", "container", "dockerBinary", "podmanBinary"])
            ],
            id: "provider",
            status: configStatus(state, ["provider", "ssh", "container", "dockerBinary", "podmanBinary"], "normal"),
            summaryLines: [compactSummary(["provider", stringValue(readPath(draft, "provider"), "unknown")])],
            title: "Provider"
        }),
        makeBox(state, "config", instanceName, {
            detailLines: [
                fieldLine("mcp.enabled", "mcp.enabled", readPath(draft, "mcp.enabled")),
                fieldLine("mcp.path", "mcp.path", readPath(draft, "mcp.path")),
                fieldLine("mcp.tools.groups", "groups", readPath(draft, "mcp.tools.groups")),
                fieldLine("mcp.tools.capabilities", "capabilities", readPath(draft, "mcp.tools.capabilities")),
                ...editorErrorLine(state, "config", "mcp-tools", ["mcp", "groups", "capabilities"])
            ],
            id: "mcp-tools",
            status: configStatus(state, ["mcp", "groups", "capabilities"], "normal"),
            summaryLines: [
                compactSummary(
                    ["enabled", stringValue(readPath(draft, "mcp.enabled"), "false")],
                    ["groups", stringValue(readPath(draft, "mcp.tools.groups"), "none")]
                )
            ],
            title: "MCP Tool Access"
        }),
        makeBox(state, "config", instanceName, {
            detailLines: [
                "",
                choiceLine("security.mode", "security.mode", readPath(draft, "security.mode")),
                choiceLine("approvalPolicy.mode", "approvalPolicy.mode", readPath(draft, "approvalPolicy.mode")),
                ...editorErrorLine(state, "config", "security", ["security", "approvalPolicy"])
            ],
            id: "security",
            status: securityStatus(state, draft),
            summaryLines: [
                compactSummary(
                    ["security", stringValue(readPath(draft, "security.mode"), "disabled")],
                    ["approval", stringValue(readPath(draft, "approvalPolicy.mode"), "disabled")]
                )
            ],
            title: "Security & Approval"
        }),
        makeBox(state, "config", instanceName, {
            detailLines: [
                fieldLine("tools.scheduler.maxRunning", "maxRunning", readPath(draft, "tools.scheduler.maxRunning")),
                fieldLine("tools.scheduler.maxRunningPerSession", "perSession", readPath(draft, "tools.scheduler.maxRunningPerSession")),
                fieldLine("tools.scheduler.queueDepth", "queueDepth", readPath(draft, "tools.scheduler.queueDepth")),
                fieldLine("tools.scheduler.queueDepthPerSession", "queuePerSession", readPath(draft, "tools.scheduler.queueDepthPerSession")),
                fieldLine("tools.scheduler.queueTimeoutMs", "queueTimeoutMs", readPath(draft, "tools.scheduler.queueTimeoutMs")),
                ...editorErrorLine(state, "config", "tool-runtime", ["tools", "scheduler"])
            ],
            id: "tool-runtime",
            status: configStatus(state, ["tools", "scheduler"], "normal"),
            summaryLines: [
                compactSummary(
                    ["maxRunning", stringValue(readPath(draft, "tools.scheduler.maxRunning"), "default")],
                    ["queueDepth", stringValue(readPath(draft, "tools.scheduler.queueDepth"), "default")]
                )
            ],
            title: "Tool Runtime"
        }),
        makeBox(state, "config", instanceName, {
            detailLines: [
                fieldLine("logs.retentionDays", "retentionDays", readPath(draft, "logs.retentionDays")),
                fieldLine("logs.maxBytes", "maxBytes", readPath(draft, "logs.maxBytes")),
                fieldLine("logs.eventBufferSize", "eventBufferSize", readPath(draft, "logs.eventBufferSize")),
                ...editorErrorLine(state, "config", "logs", ["logs"])
            ],
            id: "logs",
            status: configStatus(state, ["logs"], "normal"),
            summaryLines: [
                compactSummary(
                    ["retention", stringValue(readPath(draft, "logs.retentionDays"), "default")],
                    ["maxBytes", stringValue(readPath(draft, "logs.maxBytes"), "default")],
                    ["buffer", stringValue(readPath(draft, "logs.eventBufferSize"), "default")]
                )
            ],
            title: "Logs"
        }),
        makeBox(state, "config", instanceName, {
            detailLines: [
                `Apply mode          ${restartRequired ? "restart required" : "hot apply"}`,
                ...(restartRequired && running ? ["Save Only is unavailable until the instance is stopped."] : []),
                ...(dirty
                    ? ["", { id: "pending-changes", text: "Pending changes", tone: "warning" as const }, ...changes.map((change, index) => ({ id: `pending-change:${index}`, text: change, tone: "warning" as const }))]
                    : ["", { id: "no-pending-changes", text: "No pending changes. Hot apply is available.", tone: "success" as const }]),
                "",
                "Actions",
                buttonLine("reload", "Reload"),
                buttonLine("save", "Save Only", restartRequired && running),
                buttonLine("save-restart", "Save & Restart", !running),
                buttonLine("cancel", "Cancel"),
                buttonLine("delete", "Delete")
            ],
            id: "configuration-actions",
            status: dirty ? "warning" : restartRequired ? "warning" : "ready",
            summaryLines: [compactSummary(["apply", restartRequired ? "restart" : "hot"])],
            title: `Actions${unsaved}`
        })
    ];
}

function configStatus(state: TuiAppState, fields: readonly string[], fallback: "disabled" | "normal"): "disabled" | "failed" | "normal" {
    const error = state.interaction.editor?.kind === "config" ? state.interaction.editor.error : undefined;
    return error !== undefined && fields.some((field) => error.includes(field)) ? "failed" : fallback;
}

function securityStatus(state: TuiAppState, draft: Record<string, JsonValue>): "disabled" | "failed" | "normal" | "ready" | "warning" {
    const validation = configStatus(state, ["security", "approvalPolicy"], "normal");
    if (validation === "failed") {
        return validation;
    }

    const securityMode = readPath(draft, "security.mode");
    const approvalMode = readPath(draft, "approvalPolicy.mode");
    if (approvalMode === "deny") {
        return "failed";
    }
    if (approvalMode === "ask" || securityMode === "disabled") {
        return "warning";
    }
    if (approvalMode === "allow" && securityMode === "workspace") {
        return "ready";
    }
    if (approvalMode === "disabled") {
        return "disabled";
    }
    return "normal";
}

function draftDiff(previous: Record<string, JsonValue>, next: Record<string, JsonValue>): string[] {
    const paths = collectChangedPaths(previous, next);
    return paths.length === 0
        ? ["No semantic changes detected."]
        : paths.map((path) => `~ ${path}: ${display(readPath(previous, path))} → ${display(readPath(next, path))}`);
}

function collectChangedPaths(previous: Record<string, JsonValue>, next: Record<string, JsonValue>, prefix = ""): string[] {
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    return [...keys].sort().flatMap((key) => {
        const path = prefix.length === 0 ? key : `${prefix}.${key}`;
        const before = previous[key];
        const after = next[key];
        if (isRecord(before) && isRecord(after)) return collectChangedPaths(before, after, path);
        return JSON.stringify(before) === JSON.stringify(after) ? [] : [path];
    });
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function display(value: JsonValue | undefined): string {
    if (value === undefined) return "<unset>";
    return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
}

function providerLines(draft: Record<string, JsonValue>): Array<{ id: string; text: string }> {
    const provider = readPath(draft, "provider");
    if (provider === "ssh") {
        return [fieldLine("ssh.command", "ssh.command", readPath(draft, "ssh.command"))];
    }
    if (provider === "docker" || provider === "podman") {
        return [
            fieldLine("container.mode", "container.mode", readPath(draft, "container.mode")),
            fieldLine("container.preset", "container.preset", readPath(draft, "container.preset")),
            fieldLine("container.image", "container.image", readPath(draft, "container.image")),
            fieldLine("container.containerName", "container.name", readPath(draft, "container.containerName")),
            fieldLine("container.build.context", "build.context", readPath(draft, "container.build.context")),
            fieldLine("container.build.dockerfile", "build.dockerfile", readPath(draft, "container.build.dockerfile")),
            fieldLine("container.compose.file", "compose.file", readPath(draft, "container.compose.file")),
            fieldLine("container.compose.service", "compose.service", readPath(draft, "container.compose.service")),
            fieldLine("dockerBinary", "dockerBinary", readPath(draft, "dockerBinary")),
            fieldLine("podmanBinary", "podmanBinary", readPath(draft, "podmanBinary"))
        ];
    }
    return ["No provider-specific settings."].map((text, index) => ({ id: `provider-info:${index}`, text }));
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
    return ["provider", "ssh", "container", "dockerBinary", "podmanBinary", "logs", "mcp"].some(
        (path) => JSON.stringify(readPath(previous, path)) !== JSON.stringify(readPath(next, path))
    );
}

function stringValue(value: JsonValue | undefined, fallback: string): string {
    return value === undefined ? fallback : String(value);
}
