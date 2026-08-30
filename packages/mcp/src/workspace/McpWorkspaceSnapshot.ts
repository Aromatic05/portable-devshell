import type {
    ApprovalRequest,
    InstanceEvent,
    JsonValue,
    WaitRecord,
} from "@portable-devshell/shared";

import {
    isMcpGoalGateway,
    isMcpWorkspaceGateway,
    type McpInteractionGateway,
} from "../instance/McpInstanceGateway.js";

export async function readWorkspaceSnapshot(
    gateway: McpInteractionGateway,
    instanceName: string,
    ctxId: string,
): Promise<JsonValue> {
    const workspaceGateway = isMcpWorkspaceGateway(gateway) ? gateway : undefined;
    const goalGateway = isMcpGoalGateway(gateway) ? gateway : undefined;
    const [todo, waits, approvals, eventSlice, goal, toolCalls] = await Promise.all([
        gateway.readTodo(instanceName),
        gateway.listWaits(instanceName),
        gateway.listApprovals(instanceName),
        workspaceGateway?.readWorkspaceEvents(instanceName, Number.MAX_SAFE_INTEGER) ?? {
            events: [],
            gap: false,
            lastSeq: 0,
        },
        goalGateway?.readGoal(instanceName, ctxId),
        workspaceGateway?.readToolCalls(instanceName, ctxId, 64) ?? [],
    ]);
    const todoRecord = asRecord(todo);
    const tasks = Array.isArray(todoRecord?.tasks)
        ? todoRecord.tasks.filter((task) => asRecord(task)?.ctxId === ctxId)
        : [];
    const ownedWaits = waits.filter((wait) => wait.createdByCtxId === ctxId);
    const ownedApprovals = approvals.filter((approval) => approval.ctxId === ctxId && approval.status === "pending");
    const visibleTasks = tasks.flatMap((task) => {
        const record = asRecord(task);
        if (record === undefined) return [];
        const { ctxId: _ctxId, ...visible } = record;
        return [visible];
    });
    const visibleWaits = ownedWaits.map((wait) => {
        const {
            createdByCtxId: _createdByCtxId,
            ownerCallId: _ownerCallId,
            recoveryClaimedAt: _recoveryClaimedAt,
            recoveryClaimId: _recoveryClaimId,
            ...visible
        } = wait;
        return visible;
    });
    const visibleApprovals = ownedApprovals.map((approval) => {
        const { ctxId: _ctxId, ...visible } = approval;
        return visible;
    });
    const agentBusy = toolCalls.some((call) =>
        call.status === "queued" || call.status === "pendingApproval" || call.status === "running"
    );
    return {
        agentBusy,
        approvals: visibleApprovals,
        background: ownedWaits
            .filter((wait) => (
                wait.kind === "tmux" && (wait.status === "waiting" || wait.status === "detached")
            ) || (
                (wait.kind === "tmux" || wait.kind === "question") &&
                wait.status === "resolved" && wait.detachedAt !== undefined
            ))
            .map((wait) => ({
                ...(wait.detachedAt === undefined ? {} : { detachedAt: wait.detachedAt }),
                ...(wait.goalId === undefined ? {} : { goalId: wait.goalId }),
                kind: wait.kind,
                ...(wait.recoveryMessageAttemptedAt === undefined ? {} : { recoveryMessageAttemptedAt: wait.recoveryMessageAttemptedAt }),
                ...(wait.recoveryMessageId === undefined ? {} : { recoveryMessageId: wait.recoveryMessageId }),
                ...(wait.recoveryMessageSentAt === undefined ? {} : { recoveryMessageSentAt: wait.recoveryMessageSentAt }),
                ...(wait.result === undefined ? {} : { result: wait.result }),
                status: wait.status,
                ...(wait.taskId === undefined ? {} : { taskId: wait.taskId }),
                ...(wait.kind === "tmux" ? { tmuxTaskId: wait.targetId } : {}),
                updatedAt: wait.updatedAt,
                waitId: wait.waitId,
            })),
        ctxId,
        currentEvent: workspaceCurrentEvent(ownedWaits, ownedApprovals),
        cursor: eventSlice.lastSeq,
        goal: goal ?? null,
        instance: instanceName,
        questions: visibleWaits.filter((wait) => wait.kind === "question" && (wait.status === "waiting" || wait.status === "detached")),
        tasks: visibleTasks,
    } as unknown as JsonValue;
}

export function workspaceEventBelongsTo(event: InstanceEvent, ctxId: string): boolean {
    if (event.type === "wait.recoveryClaimed" || event.type === "wait.recoveryReleased") return false;
    const data = asRecord(event.data);
    return data?.ctxId === ctxId || data?.createdByCtxId === ctxId;
}

function workspaceCurrentEvent(waits: WaitRecord[], approvals: ApprovalRequest[]): JsonValue {
    const candidates: Array<{ rank: number; updatedAt: string; value: JsonValue }> = [];
    for (const approval of approvals) {
        candidates.push({
            rank: 0,
            updatedAt: approval.createdAt,
            value: {
                eventName: "approval.decision",
                approvalId: approval.approvalId,
                inputSummary: approval.inputSummary,
                kind: "approval",
                name: approval.toolName,
                reason: approval.reason,
                riskLevel: approval.riskLevel,
                status: "waiting",
                toolName: approval.toolName,
                updatedAt: approval.createdAt,
            },
        });
    }
    for (const wait of waits) {
        if (wait.kind === "question" && (wait.status === "waiting" || wait.status === "detached")) {
            candidates.push({
                rank: wait.status === "waiting" ? 0 : 1,
                updatedAt: wait.updatedAt,
                value: {
                    eventName: "user.answer",
                    kind: "question",
                    name: "workspace_ask",
                    ...(wait.payload === undefined ? {} : { payload: wait.payload }),
                    ...(wait.goalId === undefined ? {} : { goalId: wait.goalId }),
                    status: wait.status,
                    ...(wait.taskId === undefined ? {} : { taskId: wait.taskId }),
                    updatedAt: wait.updatedAt,
                    waitId: wait.waitId,
                },
            });
        }
    }
    candidates.sort((left, right) => left.rank - right.rank || left.updatedAt.localeCompare(right.updatedAt));
    return candidates[0]?.value ?? null;
}

function asRecord(value: JsonValue | unknown): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, JsonValue>
        : undefined;
}
