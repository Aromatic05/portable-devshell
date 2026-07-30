import type { OperationalOverviewInstance } from "@portable-devshell/shared";

import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import type { TuiExpandableBoxStatus } from "../../state/TuiUiState.js";
import type { BoxModel } from "../component/TuiComponentExpandableBox.js";
import {
    compactSummary,
    formatField,
    makeBox,
    shortenPath
} from "./TuiPageBoxSupport.js";

export function buildOverviewInstanceBoxes(
    state: TuiAppState,
    instances: readonly OperationalOverviewInstance[]
): BoxModel[] {
    if (instances.length === 0) {
        return [makeBox(state, "overview", undefined, {
            detailLines: ["No instances are currently registered."],
            id: "overview-instances-empty",
            status: "normal",
            summaryLines: ["No instances."],
            title: "Instances"
        })];
    }
    return instances.map((instance) => buildInstanceBox(state, instance));
}

function buildInstanceBox(
    state: TuiAppState,
    instance: OperationalOverviewInstance
): BoxModel {
    const snapshot = instance.snapshot;
    const worker = instance.worker;
    return makeBox(state, "overview", undefined, {
        detailLines: [
            formatField("Provider", instance.provider),
            formatField("Workspace", instance.workspace === undefined ? "—" : shortenPath(instance.workspace)),
            ...(worker === undefined ? [] : [
                formatField("Worker", `${worker.version} · protocol ${worker.protocolVersion}`),
                formatField("Platform", `${worker.platform.os}/${worker.platform.arch}`),
                ...(worker.platform.distribution === undefined
                    ? []
                    : [formatField("Distribution", [
                        worker.platform.distribution.name,
                        worker.platform.distribution.version
                    ].filter(Boolean).join(" "))]),
                ...(worker.platform.packageManager === undefined
                    ? []
                    : [formatField("Package manager", worker.platform.packageManager)]),
                ...(worker.platform.shell === undefined
                    ? []
                    : [formatField("Shell", `${worker.platform.shell.kind} ${worker.platform.shell.version}`)]),
                formatField("Capabilities", workerCapabilities(worker))
            ]),
            formatField("Runtime", snapshot.status),
            formatField("Connection", snapshot.connectionState),
            formatField("Daemon", snapshot.daemonState),
            formatField("Ready", snapshot.ready ? "yes" : "no"),
            formatField("MCP", instance.mcpEnabled ? "enabled" : "disabled"),
            formatField("Approvals", String(instance.pendingApprovals)),
            ...(snapshot.reverse?.lastSeenAt === undefined
                ? []
                : [formatField("Last seen", snapshot.reverse.lastSeenAt)]),
            ...(snapshot.lastErrorMessage === undefined
                ? []
                : [formatField("Last error", snapshot.lastErrorMessage)])
        ],
        id: `overview-instance:${instance.name}`,
        searchText: `${instance.name} ${instance.provider} ${instance.workspace ?? ""}`,
        status: instanceStatus(instance),
        summaryLines: [
            compactSummary(
                ["provider", instance.provider],
                ["status", snapshot.status],
                ["ready", snapshot.ready ? "yes" : "no"]
            ),
            compactSummary(
                ["connection", snapshot.connectionState],
                ["approvals", String(instance.pendingApprovals)],
                ["worker", worker?.version ?? "—"],
                ["platform", worker === undefined ? "—" : `${worker.platform.os}/${worker.platform.arch}`]
            )
        ],
        title: `Instance · ${instance.name}`
    });
}

function workerCapabilities(worker: NonNullable<OperationalOverviewInstance["worker"]>): string {
    return [
        worker.capabilities.tools ? "tools" : undefined,
        worker.capabilities.streaming ? "streaming" : undefined,
        worker.capabilities.cancel ? "cancel" : undefined
    ].filter(Boolean).join(", ") || "none";
}

function instanceStatus(instance: OperationalOverviewInstance): TuiExpandableBoxStatus {
    const snapshot = instance.snapshot;
    if (snapshot.status === "failed" || snapshot.connectionState === "failed" || snapshot.daemonState === "failed") {
        return "failed";
    }
    if (snapshot.ready) return "ready";
    if (snapshot.daemonState === "running" || snapshot.status === "running") return "running";
    return "warning";
}
