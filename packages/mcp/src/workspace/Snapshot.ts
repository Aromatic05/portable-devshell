import type {
    InstanceEventRecord,
    JsonValue,
    TodoTaskSummary,
} from "@portable-devshell/shared";
import {
    isMcpGoalGateway,
    isMcpWorkspaceGateway,
    type McpInstanceGateway,
    type McpInteractionGateway,
} from "../endpoint/Port.js";
import { contributeApprovals } from "./contributor/Approval.js";
import { contributeGoal } from "./contributor/Goal.js";
import { contributeTodo } from "./contributor/Todo.js";
import { contributeWaits } from "./contributor/Wait.js";
import { workspaceModelContext } from "./ModelContext.js";
import {
    projectWorkspaceReentry,
    type WorkspaceReentryDirective,
    type WorkspaceResolvedAction,
    type WorkspaceSnapshot,
} from "./ReentryView.js";

export async function readWorkspaceProjection(
    gateway: McpInteractionGateway,
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
    const workspaceGateway = isMcpWorkspaceGateway(gateway)
        ? gateway
        : undefined;
    const goalGateway = isMcpGoalGateway(gateway) ? gateway : undefined;
    const instances = [...new Set([instance, ...(options.instances ?? [])])];
    const eventSlice = await (workspaceGateway?.readWorkspaceEvents(
        instance,
        Number.MAX_SAFE_INTEGER,
    ) ?? Promise.resolve({ events: [], gap: false, lastSeq: 0 }));
    const [todoValue, waits, goal, approvalSlices, activeCallSlices] =
        await Promise.all([
            gateway.readTodo(instance),
            gateway.listWaits(instance),
            goalGateway?.readGoal(instance, ctxId),
            Promise.allSettled(
                instances.map((name) =>
                    gateway.approval.listPendingApprovals(name, ctxId),
                ),
            ),
            Promise.allSettled(
                instances.map(async (name) =>
                    workspaceGateway?.hasActiveToolCalls !== undefined
                        ? workspaceGateway.hasActiveToolCalls(name, ctxId)
                        : (
                              await (workspaceGateway?.readToolCalls(
                                  name,
                                  ctxId,
                                  64,
                              ) ?? [])
                          ).some(
                              (call) =>
                                  call.status === "queued" ||
                                  call.status === "running",
                          ),
                ),
            ),
        ]);
    const approvalEntries = approvalSlices.flatMap((value, index) =>
        value.status === "fulfilled"
            ? value.value.map((approval) => ({
                  approval,
                  instance: instances[index]!,
              }))
            : [],
    );
    const todo = asRecord(todoValue);
    const tasks = Array.isArray(todo?.tasks)
        ? (todo.tasks as unknown as TodoTaskSummary[])
        : [];
    const capability = gateway as McpInstanceGateway;
    const approvalProjection = approvalEntries.reduce(
        (result, entry) => {
            const projection = contributeApprovals(
                [entry.approval],
                ctxId,
                entry.instance,
                typeof capability.approval?.decideApproval === "function",
            );
            result.items.push(...projection.items);
            result.actions.push(...projection.actions);
            result.primaryOrder.push(...projection.primaryOrder);
            return result;
        },
        {
            items: [] as ReturnType<typeof contributeApprovals>["items"],
            actions: [] as WorkspaceResolvedAction[],
            primaryOrder: [] as ReturnType<
                typeof contributeApprovals
            >["primaryOrder"],
        },
    );
    const waitProjection = contributeWaits(waits, ctxId, instance, {
        answer: capability.resolveWait !== undefined,
        interrupt:
            capability.cancelWait !== undefined &&
            capability.reattachWait !== undefined &&
            capability.resolveWait !== undefined,
        dismissRecovery:
            capability.claimWaitRecovery !== undefined &&
            capability.completeWaitRecovery !== undefined &&
            capability.disableWaitRecovery !== undefined &&
            capability.dismissWaitRecovery !== undefined &&
            capability.markWaitRecoveryAttempted !== undefined &&
            capability.rejectWaitRecovery !== undefined &&
            capability.releaseWaitRecovery !== undefined,
    });
    const reentry = asRecord(options.reentry);
    const todoProjection = contributeTodo(
        tasks,
        ctxId,
        instance,
        gateway.controlTodo !== undefined,
    );
    const goalProjection = contributeGoal(
        goal,
        ctxId,
        instance,
        typeof reentry?.epoch === "number" ? reentry.epoch : 0,
    );
    const actions = [
        ...approvalProjection.actions,
        ...waitProjection.actions,
        ...todoProjection.actions,
        ...goalProjection.actions,
    ];
    const primary = [
        ...approvalProjection.primaryOrder,
        ...waitProjection.primaryOrder,
    ].sort(
        (left, right) =>
            left.rank - right.rank ||
            left.updatedAt.localeCompare(right.updatedAt),
    )[0]?.item;
    const agentBusy = activeCallSlices.some(
        (result) => result.status === "fulfilled" && result.value,
    );
    const presentation = {
        ...(primary === undefined ? {} : { primary }),
        work: [
            ...(goalProjection.item === undefined ? [] : [goalProjection.item]),
            ...todoProjection.items,
        ],
        background: waitProjection.background,
    };
    const snapshotBase = {
        ctxId,
        instance,
        cursor: eventSlice.lastSeq,
        agentBusy,
        presentation,
        reentry: projectWorkspaceReentry(
            options.reentry,
            waitProjection.modelWaits,
            goal,
            agentBusy,
            options.directives,
        ),
    };
    const modelContext = workspaceModelContext(
        snapshotBase as WorkspaceSnapshot,
        {
            goal,
            tasks: todoProjection.modelTasks,
            background: waitProjection.modelBackground,
        },
    );
    const snapshot: WorkspaceSnapshot = { ...snapshotBase, modelContext };
    return { snapshot, actions };
}

export async function readWorkspaceSnapshot(
    gateway: McpInteractionGateway,
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

export function workspaceEventBelongsTo(
    event: InstanceEventRecord,
    ctxId: string,
): boolean {
    if (
        event.type === "wait.recoveryClaimed" ||
        event.type === "wait.recoveryReleased"
    )
        return false;
    const data = asRecord(event.data);
    return data?.ctxId === ctxId || data?.createdByCtxId === ctxId;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}
