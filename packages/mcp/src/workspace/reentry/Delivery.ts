import type { GoalSnapshot, JsonValue, WaitRecord } from "@portable-devshell/shared";

const WAIT_CONTINUATION_MESSAGE = "Resume the existing execution from the Workspace continuation context.\n\nPerform the continuation operation, then continue the suspended work from its result.";
const GOAL_CONTINUATION_MESSAGE = "Finish the current Goal item shown in the Workspace context.\n\nThen immediately continue with the next Goal item.\n\nDo not stop after completing or reporting the current item.";
const GOAL_CONTINUATION_ENFORCEMENT = [
    "",
    "Wake attempt 2. The previous continuation produced no verifiable execution progress.",
    "Wake attempt 3. Repeated continuation attempts have not produced verifiable execution progress. Take concrete execution actions instead of only describing the state.",
    "Wake attempt 4. You have repeatedly failed to advance an actionable Goal. Stop substituting acknowledgements, plans, or status reports for execution.",
    "Wake attempt {attempt}. Critical execution failure: the Goal remains actionable after repeated continuation attempts without verifiable progress. Execute concrete work now rather than another acknowledgement, plan, status report, apology, or promise.",
] as const;

export interface WorkspaceReentryDelivery {
    kind: "explicit" | "goal" | "wait";
    message: string;
    messageId?: string;
    modelContext: JsonValue;
    sourceId: string;
}

export type WorkspaceExplicitReentryKind = "goal-resume" | "goal-retry" | "task-resume";

export function explicitReentryDelivery(
    kind: WorkspaceExplicitReentryKind,
    sourceId: string,
    snapshot: JsonValue,
): WorkspaceReentryDelivery {
    const message = kind === "goal-resume"
        ? "The user resumed the active Workspace Goal. Continue the Goal immediately from its current durable state; do not restart completed work."
        : kind === "goal-retry"
            ? "The user explicitly retried automatic execution for this Workspace Goal. Continue immediately from the current durable Goal state."
            : "The user resumed this Workspace task. Continue the task immediately from its current durable state.";
    const continuation = kind === "task-resume"
        ? { kind: "explicit", reason: kind, taskId: sourceId }
        : { goalId: sourceId, kind: "explicit", reason: kind };
    return {
        kind: "explicit",
        message,
        modelContext: workspaceModelContext(snapshot, continuation as unknown as JsonValue),
        sourceId,
    };
}

export function waitReentryDelivery(wait: WaitRecord, snapshot: JsonValue): WorkspaceReentryDelivery {
    return {
        kind: "wait",
        message: WAIT_CONTINUATION_MESSAGE,
        ...(wait.recoveryMessageId === undefined ? {} : { messageId: wait.recoveryMessageId }),
        modelContext: workspaceModelContext(snapshot, waitContinuation(wait)),
        sourceId: wait.waitId,
    };
}

export function goalReentryDelivery(
    goal: GoalSnapshot,
    continuationCount: number | undefined,
    snapshot: JsonValue,
): WorkspaceReentryDelivery {
    const attempt = goalContinuationAttempt(goal, continuationCount);
    const enforcement = GOAL_CONTINUATION_ENFORCEMENT[
        Math.min(attempt, GOAL_CONTINUATION_ENFORCEMENT.length) - 1
    ]!.replace("{attempt}", String(attempt));
    return {
        kind: "goal",
        message: [enforcement, GOAL_CONTINUATION_MESSAGE].filter(Boolean).join("\n\n"),
        ...(goal.continuationMessageId === undefined ? {} : { messageId: goal.continuationMessageId }),
        modelContext: workspaceModelContext(snapshot, goalContinuation(goal, attempt)),
        sourceId: goal.goalId,
    };
}

export function workspaceModelContext(snapshotValue: JsonValue, continuation?: JsonValue): JsonValue {
    const snapshot = record(snapshotValue);
    const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
    const background = Array.isArray(snapshot?.background) ? snapshot.background : [];
    const state = compact({
        background: background.flatMap((value) => {
            const item = record(value);
            return item === undefined ? [] : [compact({
                detachedAt: item.detachedAt,
                goalId: item.goalId,
                kind: item.kind,
                result: item.result,
                status: item.status,
                taskId: item.taskId,
                tmuxTaskId: item.tmuxTaskId,
            })];
        }),
        continuation,
        ctxId: snapshot?.ctxId,
        goal: snapshot?.goal ?? undefined,
        instance: snapshot?.instance,
        tasks: tasks.flatMap((value) => {
            const task = record(value);
            return task === undefined ? [] : [compact({
                checkpoint: task.checkpoint,
                currentItem: task.currentItem,
                status: task.status,
                taskId: task.taskId,
                title: task.title,
            })];
        }),
    });
    return {
        content: [{
            text: `portable-devshell durable Workspace state:\n${JSON.stringify(state, null, 2)}`,
            type: "text",
        }],
        structuredContent: { portableDevshellWorkspace: state },
    } as JsonValue;
}

function waitContinuation(wait: WaitRecord): JsonValue {
    const result = record(wait.result) ?? {};
    const task = record(result.task) ?? {};
    const taskId = String(wait.targetId || task.id || "");
    const isQuestion = wait.kind === "question";
    const reason = isQuestion
        ? "question-answered"
        : result.interrupted === true
            ? "tmux-wait-interrupted"
            : result.waitReason === "output"
                ? "tmux-output-ready"
                : result.waitReason === "timeout"
                    ? "tmux-read-interval-elapsed"
                    : result.timedOut === true
                        ? "tmux-wait-deadline-elapsed"
                        : task.status !== undefined && String(task.status) !== "running"
                            ? "tmux-finished"
                            : "tmux-wait-resolved";
    const afterResult = !isQuestion && (result.waitReason === "timeout" || result.timedOut === true)
        ? {
            operation: { kind: "blocking-wait", taskId, tool: "tmux_read" },
            when: "task-still-running-and-result-required",
        }
        : undefined;
    return compact({
        afterResult,
        constraints: isQuestion ? undefined : { restartTask: false },
        kind: "wait",
        nextOperation: isQuestion
            ? { kind: "resume-with-answer" }
            : { kind: "tool", taskId, tool: "tmux_read" },
        reason,
        result,
        suspendedOperation: isQuestion
            ? { kind: "workspace-question", waitId: wait.waitId }
            : { kind: "tmux-wait", taskId },
        wait: compact({
            goalId: wait.goalId,
            goalStepId: wait.goalStepId,
            kind: wait.kind,
            targetId: wait.targetId,
            taskId: wait.taskId,
            waitId: wait.waitId,
        }),
    }) as unknown as JsonValue;
}

function goalContinuation(goal: GoalSnapshot, attempt: number): JsonValue {
    const currentItem = goal.steps.find((step) => step.status === "active") ??
        goal.steps.find((step) => step.status === "pending");
    const currentIndex = currentItem === undefined ? -1 : goal.steps.indexOf(currentItem);
    const terminalItem = {
        id: "finish-goal",
        kind: "goal-terminal",
        status: "pending",
        text: "Complete the Goal.",
    };
    const orderedItems = [...goal.steps, terminalItem];
    return compact({
        attempt,
        continuationMessageId: goal.continuationMessageId,
        currentItem: orderedItems[currentIndex],
        goalId: goal.goalId,
        kind: "goal",
        nextItem: orderedItems[currentIndex + 1],
        noActionStreak: goal.noActionStreak,
        objective: goal.objective,
        orderedItems,
        stagnationStreak: goal.stagnationStreak,
    }) as JsonValue;
}

function goalContinuationAttempt(goal: GoalSnapshot, continuationCount: number | undefined): number {
    if (Number.isFinite(goal.noActionStreak)) return Math.max(1, Math.floor(goal.noActionStreak!) + 1);
    if (Number.isFinite(continuationCount)) return Math.max(1, Math.floor(continuationCount!));
    return Math.max(1, goal.continuationCount + 1);
}

function record(value: unknown): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, JsonValue>
        : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
