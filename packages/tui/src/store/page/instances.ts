import type { JsonValue } from "@portable-devshell/shared";

import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState } from "../TuiReducers.js";
import { compactSummary, formatField, makeBox, runtimeStatus, shortenPath } from "./PageBoxSupport.js";
import { buttonLine, editorDraft, fieldLine, readPath } from "./EditorSupport.js";

export function buildInstancesPageBoxes(state: TuiAppState): BoxModel[] {
    if (state.interaction.editor?.kind === "create") {
        return [buildCreateWizard(state)];
    }

    return [
        makeBox(state, "instances", undefined, {
            detailLines: [
                "Create a new devshell entry.",
                "",
                "Provider types",
                "local       current host",
                "ssh         remote host",
                "docker      container-backed devshell",
                "podman      rootless/container-backed devshell",
                "",
                "Actions",
                buttonLine("create", "Create")
            ],
            id: "create-instance",
            status: "normal",
            summaryLines: ["create local / ssh / docker / podman devshell"],
            title: "Create Instance"
        }),
        ...state.instances.map((entry) => {
            const snapshot = state.snapshotsByInstance[entry.name];
            const approvals = (state.approvalsByInstance[entry.name] ?? []).filter((approval) => approval.status === "pending");
            const restart = shouldRestart(snapshot);

            return makeBox(state, "instances", entry.name, {
                detailLines: [
                    {
                        id: `instance.toggleEnabled:${entry.name}`,
                        text: `enabled       [ ${entry.enabled ? "yes" : "no"} ]`,
                        tone: "accent"
                    },
                    formatField("provider", entry.provider ?? "unknown"),
                    formatField("workspace", entry.defaultWorkspace ?? "-"),
                    formatField("runtime", instanceRuntimeSummary(snapshot)),
                    formatField("approvals", String(approvals.length)),
                    "",
                    "Actions",
                    buttonLine("attach-shell", "Attach Shell"),
                    buttonLine(restart ? "restart" : "start", restart ? "Restart" : "Start"),
                    buttonLine("stop", "Stop"),
                    buttonLine("delete", "Delete")
                ],
                expandedKey: `instances:${entry.name}:instance`,
                id: `instance:${entry.name}`,
                status: entry.enabled ? runtimeStatus(snapshot) : "disabled",
                summaryLines: [
                    compactSummary(
                        ["provider", entry.provider ?? "unknown"],
                        ["workspace", shortenPath(entry.defaultWorkspace ?? "-")],
                        ["approvals", String(approvals.length)]
                    )
                ],
                title: entry.name
            });
        })
    ];
}

function instanceRuntimeSummary(snapshot: TuiAppState["snapshotsByInstance"][string] | undefined): string {
    if (snapshot?.ready === true) {
        return "ready";
    }

    return `daemon=${snapshot?.daemonState ?? "unknown"} rpc=${snapshot?.connectionState ?? "unknown"} ready=no`;
}

function shouldRestart(snapshot: TuiAppState["snapshotsByInstance"][string] | undefined): boolean {
    return snapshot?.daemonState !== undefined && snapshot.daemonState !== "stopped" && snapshot.daemonState !== "failed";
}

function buildCreateWizard(state: TuiAppState): BoxModel {
    const editor = state.interaction.editor!;
    const draft = editorDraft(state, editor.key, defaultCreateDraft());
    const step = editor.step ?? 1;
    const error = editor.error;
    const summary = editor.summary === undefined ? undefined : JSON.stringify(editor.summary);
    const detailLines = [
        `Step ${step}/5 ${stepName(step)}`,
        "",
        ...wizardFields(step, draft),
        ...(error === undefined ? [] : [{ id: "validation-error", text: `error: ${error}`, tone: "danger" as const }]),
        ...(summary === undefined ? [] : [{ id: "validation-summary", text: `validated: ${summary}`, tone: "success" as const }]),
        "",
        buttonLine("back", "Back"),
        buttonLine("next", "Next"),
        buttonLine("validate", "Validate"),
        buttonLine("create", "Create"),
        buttonLine("cancel", "Cancel")
    ];

    return makeBox(state, "instances", undefined, {
        detailLines,
        expandedKey: "instances:all:create-wizard",
        id: "create-wizard",
        status: error === undefined ? "normal" : "failed",
        summaryLines: [`step=${stepName(step).toLowerCase()}  provider=${String(readPath(draft, "provider") ?? "local")}`],
        title: "Create"
    });
}

function wizardFields(step: number, draft: Record<string, JsonValue>): Array<string | { id: string; text: string }> {
    switch (step) {
        case 1:
            return [
                fieldLine("name", "name", readPath(draft, "name")),
                fieldLine("provider", "provider", readPath(draft, "provider")),
                fieldLine("workspace", "defaultWorkspace", readPath(draft, "workspace")),
                fieldLine("enabled", "enabled", readPath(draft, "enabled"))
            ];
        case 2:
            return [
                fieldLine("ssh.command", "ssh command", readPath(draft, "ssh.command")),
                fieldLine("container.mode", "container mode", readPath(draft, "container.mode")),
                fieldLine("container.preset", "distro preset", readPath(draft, "container.preset")),
                fieldLine("container.image", "existing image", readPath(draft, "container.image")),
                fieldLine("container.containerName", "stopped container", readPath(draft, "container.containerName")),
                fieldLine("container.build.context", "dockerfile context", readPath(draft, "container.build.context")),
                fieldLine("container.build.dockerfile", "dockerfile", readPath(draft, "container.build.dockerfile")),
                fieldLine("container.compose.file", "compose file", readPath(draft, "container.compose.file")),
                fieldLine("container.compose.service", "compose service", readPath(draft, "container.compose.service")),
                "Modes: Distro preset -> preset; Dockerfile -> dockerfile; Compose -> compose",
                "       Existing image -> existingImage; Existing stopped container -> existingStoppedContainer"
            ];
        case 3:
            return [
                fieldLine("mcp.enabled", "mcp.enabled", readPath(draft, "mcp.enabled")),
                `path preview        /${String(readPath(draft, "name") ?? "<name>")}/mcp`,
                fieldLine("mcp.allowTools", "allowTools", readPath(draft, "mcp.allowTools"))
            ];
        case 4:
            return [fieldLine("security.mode", "security mode", readPath(draft, "security.mode")), "approval policy: not available in create schema"];
        default:
            return ["Review normalized draft", JSON.stringify(draft)];
    }
}

function defaultCreateDraft(): Record<string, JsonValue> {
    return {
        enabled: true,
        mcp: { allowTools: ["bash_run"], enabled: true },
        name: "",
        provider: "local",
        security: { mode: "disabled" },
        workspace: ""
    };
}

function stepName(step: number): string {
    return ["Basic", "Provider", "MCP", "Security / Approval", "Review"][step - 1] ?? "Review";
}
