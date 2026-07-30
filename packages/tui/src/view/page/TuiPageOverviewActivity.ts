import type { OperationalOverviewActivity } from "@portable-devshell/shared";

import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import type { TuiExpandableBoxStatus } from "../../state/TuiUiState.js";
import type { BoxModel } from "../component/TuiComponentExpandableBox.js";
import { buttonLine } from "../editor/TuiEditorView.js";
import {
    compactSummary,
    formatField,
    makeBox
} from "./TuiPageBoxSupport.js";

export function buildOverviewActivityBoxes(
    state: TuiAppState,
    activity: readonly OperationalOverviewActivity[]
): BoxModel[] {
    if (activity.length === 0) {
        return [makeBox(state, "overview", undefined, {
            detailLines: ["No recent tool activity is available."],
            id: "overview-activity-empty",
            status: "normal",
            summaryLines: ["No recent activity."],
            title: "Activity"
        })];
    }
    return activity.map((record) => buildActivityBox(state, record));
}

function buildActivityBox(
    state: TuiAppState,
    activity: OperationalOverviewActivity
): BoxModel {
    return makeBox(state, "overview", undefined, {
        detailLines: [
            formatField("Instance", activity.instance),
            formatField("Tool", activity.toolName),
            formatField("Source", activity.source),
            formatField("Status", activity.status),
            formatField("Started", activity.startedAt),
            ...(activity.completedAt === undefined
                ? []
                : [formatField("Completed", activity.completedAt)]),
            ...(activity.errorSummary === undefined
                ? []
                : [formatField("Error", activity.errorSummary)]),
            formatField("Call ID", activity.callId),
            buttonLine(
                `overview-open-audit:${encodeURIComponent(activity.instance)}:${encodeURIComponent(activity.callId)}`,
                "Open Audit"
            )
        ],
        id: `overview-activity:${activity.callId}`,
        searchText: `${activity.instance} ${activity.toolName} ${activity.status} ${activity.errorSummary ?? ""}`,
        status: activityStatus(activity),
        summaryLines: [
            compactSummary(
                ["instance", activity.instance],
                ["tool", activity.toolName],
                ["status", activity.status]
            ),
            activity.errorSummary ?? `${activity.source} · ${activity.startedAt}`
        ],
        title: `Activity · ${activity.toolName}`
    });
}

function activityStatus(activity: OperationalOverviewActivity): TuiExpandableBoxStatus {
    switch (activity.status) {
        case "completed":
            return "ready";
        case "running":
            return "running";
        case "queued":
        case "pendingApproval":
            return "pending";
        case "cancelled":
            return "warning";
        case "failed":
        case "denied":
        case "expired":
        case "queueTimeout":
            return "failed";
    }
}
