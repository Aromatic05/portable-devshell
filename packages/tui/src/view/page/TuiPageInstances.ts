import type {
    InstanceSnapshot, JsonValue } from "@portable-devshell/shared";

import { isTuiTerminalSupported } from "../../state/instance/TuiInstanceTerminalCapability.js";
import { buildArtifactActivityView } from "../component/TuiComponentArtifactActivityBox.js";
import { createDefaultInstanceDraft } from "../../state/editor/TuiEditorInstanceCreateDraft.js";
import type { BoxModel } from "../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import { compactSummary, formatField, makeBox, runtimeStatus } from "./TuiPageBoxSupport.js";
import { editorDraft, readPath } from "../../state/editor/TuiEditorDraft.js";
import { buttonLine, choiceLine, fieldLine, secretFieldLine, secretRecordFieldLine } from "../editor/TuiEditorView.js";

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
                "reverse     self-managed outbound worker",
                "",
                "Actions",
                buttonLine("create", "Create")
            ],
            id: "create-instance",
            status: "normal",
            summaryLines: ["create local / ssh / docker / podman / reverse devshell"],
            title: "Create Instance"
        }),
        ...state.instances.map((entry) => {
            const snapshot = state.readModel.instanceState[entry.name]?.snapshot;
            const approvals = (state.readModel.instanceState[entry.name]?.approvals ?? []).filter((approval) => approval.status === "pending");
            const lifecycle = lifecycleAvailability(state, entry.name, entry.enabled, entry.provider, snapshot);
            const artifactActivity = buildArtifactActivityView(
                entry.name,
                state.readModel.artifactShares,
                state.readModel.artifactTransfers
            );

            return makeBox(state, "instances", entry.name, {
                detailLines: [
                    {
                        id: `instance.toggleEnabled:${entry.name}`,
                        text: `enabled       [ ${entry.enabled ? "yes" : "no"} ]`,
                        tone: "accent"
                    },
                    formatField("provider", entry.provider ?? "unknown"),
                    formatField("home", entry.homeDirectory ?? "-"),
                    formatField("runtime", instanceRuntimeSummary(snapshot)),
                    formatField("approvals", String(approvals.length)),
                    ...(snapshot?.reverse === undefined
                        ? []
                        : [
                              formatField("management", snapshot.reverse.managementMode),
                              formatField("enrollment", snapshot.reverse.enrollmentState),
                              formatField("availability", snapshot.reverse.availability),
                              formatField("transport", snapshot.reverse.transport ?? "-"),
                              formatField("generation", String(snapshot.reverse.generation ?? "-")),
                              formatField("last seen", snapshot.reverse.lastSeenAt ?? "-"),
                              ...(snapshot.reverse.lastErrorCode === undefined
                                  ? []
                                  : [
                                        formatField("last error", snapshot.reverse.lastErrorCode),
                                        formatField("error detail", snapshot.reverse.lastErrorMessage ?? "-")
                                    ])
                          ]),
                    "",
                    ...artifactActivity.detailLines,
                    "",
                    "Actions",
                    buttonLine("open-terminal", "Open Terminal", !lifecycle.attach),
                    ...(snapshot?.reverse?.managementMode === "selfManaged"
                        ? ["Lifecycle           managed on remote machine"]
                        : [
                              buttonLine(lifecycle.restart ? "restart" : "start", lifecycle.restart ? "Restart" : "Start", !lifecycle.startOrRestart),
                              buttonLine("stop", "Stop", !lifecycle.stop)
                          ]),
                    buttonLine("delete", "Delete")
                ],
                expandedKey: `instances:${entry.name}:instance`,
                id: `instance:${entry.name}`,
                status: entry.enabled ? runtimeStatus(snapshot) : "disabled",
                summaryLines: [
                    compactSummary(
                        ["provider", entry.provider ?? "unknown"],
                        ["home", entry.homeDirectory ?? "-"],
                        ["approvals", String(approvals.length)]
                    ),
                    artifactActivity.summary
                ],
                title: entry.name
            });
        })
    ];
}

function instanceRuntimeSummary(snapshot: InstanceSnapshot | undefined): string {
    if (snapshot?.ready === true) {
        return "ready";
    }

    return `daemon=${snapshot?.daemonState ?? "unknown"} rpc=${snapshot?.connectionState ?? "unknown"} ready=no`;
}

function lifecycleAvailability(
    state: TuiAppState,
    instance: string,
    enabled: boolean,
    provider: string | undefined,
    snapshot: InstanceSnapshot | undefined
): { attach: boolean; restart: boolean; startOrRestart: boolean; stop: boolean } {
    const busy = state.commandRecords.some((record) => record.targetInstance === instance && record.status === "running");
    const daemon = snapshot?.daemonState;
    const running = daemon === "running" || snapshot?.ready === true;
    const transitional = busy || daemon === "starting" || daemon === "stopping";
    const selfManaged = snapshot?.reverse?.managementMode === "selfManaged";
    const reverseOnline = snapshot?.reverse?.availability === "online";
    const restart = !selfManaged && running;

    return {
        attach: enabled &&
            isTuiTerminalSupported(provider) &&
            (selfManaged ? reverseOnline : running) &&
            !transitional,
        restart,
        startOrRestart: enabled && !selfManaged && !transitional,
        stop: enabled && !selfManaged && running && !transitional
    };
}

function buildCreateWizard(state: TuiAppState): BoxModel {
    const editor = state.interaction.editor!;
    const draft = editorDraft(state, editor.key, createDefaultInstanceDraft());
    const step = editor.step ?? 1;
    const error = editor.error;
    const summary = editor.summary === undefined ? undefined : JSON.stringify(redactCreateSecrets(editor.summary as unknown as JsonValue));
    const detailLines = [
        `Step ${step}/6 ${stepName(step)}`,
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
                choiceLine("provider", "provider", readPath(draft, "provider")),
                choiceLine("enabled", "enabled", readPath(draft, "enabled"))
            ];
        case 2:
            return providerWizardFields(draft);
        case 3: {
            const auth = readPath(draft, "mcp.auth");
            return [
                choiceLine("mcp.enabled", "mcp.enabled", readPath(draft, "mcp.enabled")),
                choiceLine("mcp.auth", "mcp.auth", auth),
                ...(auth === "token"
                    ? [secretFieldLine("mcp.token", "token", readPath(draft, "mcp.token"))]
                    : []),
                ...(auth === "oauth2"
                    ? [
                          fieldLine("mcp.oauth2.resourceName", "resource", readPath(draft, "mcp.oauth2.resourceName")),
                          fieldLine("mcp.oauth2.requiredScopes", "scopes", readPath(draft, "mcp.oauth2.requiredScopes")),
                          fieldLine("mcp.oauth2.documentationUrl", "documentationUrl", readPath(draft, "mcp.oauth2.documentationUrl"))
                      ]
                    : []),
                `path preview        /${String(readPath(draft, "name") ?? "<name>")}/mcp`,
                fieldLine("mcp.tools.groups", "groups", readPath(draft, "mcp.tools.groups")),
                fieldLine("mcp.tools.capabilities", "capabilities", readPath(draft, "mcp.tools.capabilities"))
            ];
        }
        case 4:
            return [
                choiceLine("security.mode", "security mode", readPath(draft, "security.mode")),
                choiceLine("approvalPolicy.mode", "approval mode", readPath(draft, "approvalPolicy.mode")),
                fieldLine("approvalPolicy.rules", "approval rules", readPath(draft, "approvalPolicy.rules"))
            ];
        case 5:
            return [
                secretRecordFieldLine("env", "environment JSON", readPath(draft, "env")),
                fieldLine("logs.retentionDays", "retentionDays", readPath(draft, "logs.retentionDays")),
                fieldLine("logs.maxBytes", "maxBytes", readPath(draft, "logs.maxBytes")),
                fieldLine("logs.eventBufferSize", "eventBufferSize", readPath(draft, "logs.eventBufferSize")),
                fieldLine("tools.scheduler.maxRunning", "maxRunning", readPath(draft, "tools.scheduler.maxRunning")),
                fieldLine("tools.scheduler.maxRunningPerSession", "perSession", readPath(draft, "tools.scheduler.maxRunningPerSession")),
                fieldLine("tools.scheduler.queueDepth", "queueDepth", readPath(draft, "tools.scheduler.queueDepth")),
                fieldLine("tools.scheduler.queueDepthPerSession", "queuePerSession", readPath(draft, "tools.scheduler.queueDepthPerSession")),
                fieldLine("tools.scheduler.queueTimeoutMs", "queueTimeoutMs", readPath(draft, "tools.scheduler.queueTimeoutMs")),
                fieldLine("tools.scheduler.byTool", "byTool JSON", readPath(draft, "tools.scheduler.byTool"))
            ];
        default:
            return ["Review normalized draft", JSON.stringify(redactCreateSecrets(draft))];
    }
}

function providerWizardFields(draft: Record<string, JsonValue>): Array<string | { id: string; text: string }> {
    const provider = readPath(draft, "provider");
    if (provider === "ssh") {
        return [fieldLine("ssh.command", "ssh command", readPath(draft, "ssh.command"))];
    }
    if (provider !== "docker" && provider !== "podman") {
        return ["No provider-specific settings."];
    }

    const mode = readPath(draft, "container.mode");
    const common = [
        choiceLine("container.mode", "container mode", mode),
        ...(provider === "docker"
            ? [fieldLine("dockerBinary", "docker binary", readPath(draft, "dockerBinary"))]
            : [fieldLine("podmanBinary", "podman binary", readPath(draft, "podmanBinary"))])
    ];
    switch (mode) {
        case "preset":
            return [
                ...common,
                choiceLine("container.preset", "distro preset", readPath(draft, "container.preset")),
                fieldLine("container.image", "image", readPath(draft, "container.image")),
                ...managedContainerFields(draft)
            ];
        case "dockerfile":
            return [
                ...common,
                fieldLine("container.build.context", "build context", readPath(draft, "container.build.context")),
                fieldLine("container.build.dockerfile", "dockerfile", readPath(draft, "container.build.dockerfile")),
                fieldLine("container.build.tag", "build tag", readPath(draft, "container.build.tag")),
                ...managedContainerFields(draft)
            ];
        case "compose":
            return [
                ...common,
                fieldLine("container.compose.file", "compose file", readPath(draft, "container.compose.file")),
                fieldLine("container.compose.service", "compose service", readPath(draft, "container.compose.service")),
                fieldLine("container.compose.projectName", "project name", readPath(draft, "container.compose.projectName"))
            ];
        case "existingImage":
            return [
                ...common,
                fieldLine("container.image", "existing image", readPath(draft, "container.image")),
                ...managedContainerFields(draft)
            ];
        case "existingStoppedContainer":
            return [
                ...common,
                fieldLine("container.containerName", "stopped container", readPath(draft, "container.containerName")),
                fieldLine("container.adoptLifecycle", "adopt lifecycle", readPath(draft, "container.adoptLifecycle"))
            ];
        default:
            return common;
    }
}

function managedContainerFields(draft: Record<string, JsonValue>): Array<{ id: string; text: string }> {
    return [
        fieldLine("container.containerName", "container name", readPath(draft, "container.containerName")),
        fieldLine("container.user", "user", readPath(draft, "container.user")),
        fieldLine("container.network", "network", readPath(draft, "container.network")),
        fieldLine("container.mounts", "mounts JSON", readPath(draft, "container.mounts")),
        secretRecordFieldLine("container.env", "container env JSON", readPath(draft, "container.env"))
    ];
}

function stepName(step: number): string {
    return ["Basic", "Provider", "MCP", "Security / Approval", "Runtime", "Review"][step - 1] ?? "Review";
}

function redactCreateSecrets(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(redactCreateSecrets);
    if (typeof value !== "object" || value === null) return value;
    const output: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (key === "token" && typeof entry === "string") {
            output[key] = "********";
            continue;
        }
        if (key === "env" && typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
            output[key] = Object.fromEntries(Object.keys(entry).map((name) => [name, "********"]));
            continue;
        }
        output[key] = redactCreateSecrets(entry);
    }
    return output;
}
