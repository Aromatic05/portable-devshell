import type { JsonValue } from "@portable-devshell/shared";

import type { McpWorkspaceActionGateway } from "../endpoint/Port.js";
import { workspaceModelContext } from "./ModelContext.js";
import { projectWorkspaceReentry } from "./ReentryView.js";
import type {
    WorkspaceReentryDirective,
    WorkspaceResolvedAction,
    WorkspaceSnapshot,
} from "./Contract.js";
import {
    readWorkspaceBusy,
    readWorkspaceCursor,
} from "./contributor/Activity.js";
import { readApprovalContribution } from "./contributor/Approval.js";
import { readTaskContribution } from "./contributor/Task.js";

export async function readWorkspaceProjection(
    gateway: McpWorkspaceActionGateway,
    instance: string,
    ctxId: string,
    options: {
        instances?: string[];
        reentry?: JsonValue;
        directives?: WorkspaceReentryDirective[];
    } = {},
): Promise<{
    snapshot: WorkspaceSnapshot;
    actions: WorkspaceResolvedAction[];
}> {
    const instances = [...new Set([instance, ...(options.instances ?? [])])];
    // Capture the event cursor before reading domain state. A later cursor could
    // acknowledge an event whose corresponding domain mutation is not reflected
    // in this projection yet, causing a watcher to skip that update permanently.
    const cursor = await readWorkspaceCursor(gateway, instance);
    const [approval, task, agentBusy] = await Promise.all([
        readApprovalContribution(gateway, ctxId, instances),
        readTaskContribution(gateway, instance, ctxId, options.reentry),
        readWorkspaceBusy(gateway, ctxId, instances),
    ]);
    const primary = [...approval.primaryOrder, ...task.primaryOrder].sort(
        (left, right) =>
            left.rank - right.rank ||
            left.updatedAt.localeCompare(right.updatedAt),
    )[0]?.item;
    const presentation = {
        ...(primary === undefined ? {} : { primary }),
        work: task.work,
        background: task.background,
    };
    const snapshotBase = {
        ctxId,
        instance,
        cursor,
        agentBusy,
        presentation,
        reentry: projectWorkspaceReentry(
            options.reentry,
            task.model.waits,
            task.model.goal,
            agentBusy,
            options.directives,
        ),
    };
    const modelContext = workspaceModelContext(
        snapshotBase as WorkspaceSnapshot,
        {
            goal: task.model.goal,
            tasks: task.model.tasks,
            background: task.model.background,
        },
    );
    return {
        snapshot: { ...snapshotBase, modelContext },
        actions: [...approval.actions, ...task.actions],
    };
}

export async function readWorkspaceSnapshot(
    gateway: McpWorkspaceActionGateway,
    instance: string,
    ctxId: string,
    options: {
        instances?: string[];
        reentry?: JsonValue;
        directives?: WorkspaceReentryDirective[];
    } = {},
): Promise<JsonValue> {
    const { snapshot } = await readWorkspaceProjection(
        gateway,
        instance,
        ctxId,
        options,
    );
    return snapshot as unknown as JsonValue;
}
