import type { JsonValue } from "@portable-devshell/shared";

import type { McpAppActionGateway } from "../instance/Gateway.js";
import { mcpAppModelContext } from "./ModelContext.js";
import { projectMcpAppReentry } from "./ReentryView.js";
import type {
    McpAppReentryDirective,
    McpAppResolvedAction,
    McpAppSnapshot,
} from "./model/Contract.js";
import {
    readMcpAppBusy,
    readMcpAppCursor,
} from "./contributor/Activity.js";
import { readApprovalContribution } from "./contributor/Approval.js";
import { readTaskContribution } from "./contributor/Task.js";

export async function readMcpAppProjection(
    gateway: McpAppActionGateway,
    instance: string,
    ctxId: string,
    options: {
        instances?: string[];
        reentry?: JsonValue;
        directives?: McpAppReentryDirective[];
    } = {},
): Promise<{
    snapshot: McpAppSnapshot;
    actions: McpAppResolvedAction[];
}> {
    const instances = [...new Set([instance, ...(options.instances ?? [])])];
    // Capture the event cursor before reading domain state. A later cursor could
    // acknowledge an event whose corresponding domain mutation is not reflected
    // in this projection yet, causing a watcher to skip that update permanently.
    const cursor = await readMcpAppCursor(gateway, instance);
    const [approval, task, agentBusy] = await Promise.all([
        readApprovalContribution(gateway, ctxId, instances),
        readTaskContribution(gateway, instance, ctxId, options.reentry),
        readMcpAppBusy(gateway, ctxId, instances),
    ]);
    const primary = [...approval.primaryOrder].sort(
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
        reentry: projectMcpAppReentry(
            options.reentry,
            task.model.goal,
            agentBusy,
            options.directives,
        ),
    };
    const modelContext = mcpAppModelContext(
        snapshotBase as unknown as McpAppSnapshot,
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

export async function readMcpAppSnapshot(
    gateway: McpAppActionGateway,
    instance: string,
    ctxId: string,
    options: {
        instances?: string[];
        reentry?: JsonValue;
        directives?: McpAppReentryDirective[];
    } = {},
): Promise<JsonValue> {
    const { snapshot } = await readMcpAppProjection(
        gateway,
        instance,
        ctxId,
        options,
    );
    return snapshot as unknown as JsonValue;
}
