import {
    createApprovalTransport,
    createInstanceRuntimeTransport,
    createTaskTransport,
    type Endpoint,
    type ApprovalRequest,
    type GoalSnapshot,
    type TodoReadResult,
    type WaitRecord,
} from "@portable-devshell/shared";
import { mcpAppModelContext } from "./ModelContext.js";
import { projectMcpAppReentry } from "./ReentryView.js";
import type { McpAppActionStore } from "./ActionStore.js";
import type { McpAppReentryDirective, McpAppSnapshot, McpAppWorkItem } from "./model/Contract.js";

/** Present authoritative Instance snapshots without retaining another domain state. */
export function projectMcpAppSnapshot(input: {
    approvals: { approvals: ApprovalRequest[]; lastSeq: number };
    ctxId: string;
    goal: { goal: GoalSnapshot | null; lastSeq: number };
    instance: string;
    todo: { todo: TodoReadResult; lastSeq: number };
    directives?: McpAppReentryDirective[];
    waits?: { waits: WaitRecord[]; lastSeq: number };
    workspace?: string;
}): McpAppSnapshot {
    // The caller must use task.getGoal(ctxId), not the Instance-wide getGoals().
    // Several independent Contexts may use the same Workspace.
    const goals = input.goal.goal === null ||
        (input.workspace !== undefined && input.goal.goal.workspace !== input.workspace)
        ? [] : [input.goal.goal];
    const approvals = input.approvals.approvals.filter((entry) =>
        entry.ctxId === input.ctxId && entry.status === "pending",
    );
    const tasks = (input.todo.todo.tasks ?? []).filter((task) => task.ctxId === input.ctxId);
    const waits = (input.waits?.waits ?? []).filter((wait) => wait.ctxId === input.ctxId);
    const work: McpAppWorkItem[] = [
        ...goals.filter((goal) => goal.status !== "completed" && goal.status !== "stopped")
            .map((goal) => ({
                kind: "work" as const,
                id: goal.goalId,
                title: goal.objective,
                state: goal.status === "active" ? "running" as const
                    : goal.status === "blocked" ? "blocked" as const : "paused" as const,
                badge: `Goal · ${goal.status}`,
                ...(goal.note ? { note: goal.note } : {}),
                progress: {
                    current: goal.steps.filter((step) => step.status === "completed").length,
                    total: goal.steps.length,
                },
                actions: [
                    goal.status === "active"
                        ? { id: "goal-pause", label: "Pause", expectedRevision: goal.revision }
                        : { id: "goal-resume", label: "Resume", expectedRevision: goal.revision },
                    { id: "goal-stop", label: "Stop", tone: "danger" as const,
                        confirmation: { message: "Stop this Goal?" }, expectedRevision: goal.revision },
                ],
            })),
        ...tasks.filter((task) => task.status !== "completed" && task.status !== "cancelled")
            .map((task) => ({
                kind: "work" as const,
                id: task.taskId,
                title: task.title,
                state: task.status === "in_progress" ? "running" as const
                    : task.status === "blocked" || task.status === "failed" ? "blocked" as const
                    : "paused" as const,
                badge: `Task · ${task.status}`,
                ...(task.currentItem ? { current: task.currentItem } : {}),
                ...(task.checkpoint?.summary ? { note: task.checkpoint.summary } : {}),
                progress: { current: task.completed, total: task.total },
                actions: [
                    task.pausedAt
                        ? { id: "task-resume", label: "Resume", expectedRevision: task.revision }
                        : { id: "task-pause", label: "Pause", expectedRevision: task.revision },
                    { id: "task-cancel", label: "Cancel", tone: "danger" as const,
                        confirmation: { message: "Cancel this Task?" }, expectedRevision: task.revision },
                ],
            })),
    ];
    const snapshot: McpAppSnapshot = {
        ctxId: input.ctxId,
        instance: input.instance,
        // Each authority captured a cursor before its read. Starting at their
        // minimum means changes racing with any read cannot be missed.
        cursor: Math.min(input.approvals.lastSeq, input.goal.lastSeq, input.todo.lastSeq, input.waits?.lastSeq ?? Number.MAX_SAFE_INTEGER),
        agentBusy: work.some((item) => item.state === "running"),
        presentation: {
            ...(approvals[0] === undefined ? {} : {
                primary: {
                    kind: "decision",
                    id: approvals[0].approvalId,
                    title: "Approval required",
                    summary: approvals[0].toolName,
                    detail: approvals[0].inputSummary,
                    actions: [
                        { id: "approve", label: "Approve", tone: "primary" as const },
                        { id: "deny", label: "Deny", tone: "danger" as const,
                            confirmation: { message: "Deny this approval request?" } },
                    ],
                },
            }),
            work,
            background: waits.map((wait) => ({
                kind: "background",
                id: wait.waitId,
                title: wait.toolName,
                badge: `Wait · ${wait.status}`,
                summary: wait.targetId,
                actions: [],
            })),
        },
        modelContext: {
            content: [],
            structuredContent: { portableDevshellMcpApp: null },
        },
        // A running Goal does not prove an active ToolCall. Goal continuationDue
        // already accounts for recent agent activity and persisted claims.
        reentry: projectMcpAppReentry({ mode: "automatic" }, goals[0], false, input.directives),
    };
    snapshot.modelContext = mcpAppModelContext(snapshot, {
        ...(goals[0] === undefined ? {} : { goal: goals[0] }),
        tasks,
        background: waits.map((wait) => ({
            kind: "tmux", status: wait.status, targetId: wait.targetId,
            detachedAt: wait.createdAt,
        })),
    });
    return snapshot;
}

/** Reads existing Instance authorities; holds no independent workspace state. */
export function createMcpAppViewModel(endpoint: Endpoint, actions?: McpAppActionStore) {
    const snapshot = async (instance: string, ctxId: string, workspace?: string) => {
        const task = createTaskTransport(endpoint, instance);
        const approval = createApprovalTransport(endpoint, instance);
        const [goal, todo, approvals, waits, directives] = await Promise.all([
            task.getGoal(ctxId), task.getTodo(), approval.snapshot({ pendingOnly: true }), task.getWaits(ctxId),
            actions?.pendingDirectives(ctxId, instance) ?? Promise.resolve([]),
        ]);
        return projectMcpAppSnapshot({
            approvals, ctxId, goal, instance, todo, waits, directives,
            ...(workspace === undefined ? {} : { workspace }),
        });
    };
    const watch = async (
        instance: string, ctxId: string, workspace: string | undefined,
        cursor: number, signal?: AbortSignal,
    ): Promise<{ changed: boolean; cursor: number; snapshot?: McpAppSnapshot }> => {
        if (!Number.isSafeInteger(cursor) || cursor < 0)
            throw new TypeError("MCP App watch cursor must be a non-negative integer.");
        if (signal?.aborted) return { changed: false, cursor };
        const stream = await createInstanceRuntimeTransport(endpoint, instance)
            .subscribeEvents(cursor + 1);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancel: (() => void) | undefined;
        const interrupted = new Promise<"timeout" | "aborted">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), 20_000);
            cancel = () => resolve("aborted");
            signal?.addEventListener("abort", cancel, { once: true });
        });
        try {
            const result = await Promise.race([stream.next(), interrupted]);
            if (result === "aborted") return { changed: false, cursor };
            if (result === "timeout") {
                // Time alone can make an Instance Goal due, without an event.
                // React receives the server's decision, not a local timer.
                const due = await snapshot(instance, ctxId, workspace);
                if (due.reentry.schedule === undefined && !due.reentry.pending)
                    return { changed: false, cursor };
                due.cursor = Math.max(due.cursor, cursor);
                return { changed: true, cursor: due.cursor, snapshot: due };
            }
            if (result.kind === "closed")
                throw result.error ?? new Error("Instance Event stream closed unexpectedly.");
            const next = await snapshot(instance, ctxId, workspace);
            // An event not relevant to this Context must still advance the
            // cursor. Otherwise the next watch replays the same event forever.
            const observed = result.kind === "event" ? result.event.seq : result.gap.lastSeq;
            next.cursor = Math.max(next.cursor, observed, cursor);
            return { changed: true, cursor: next.cursor, snapshot: next };
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            if (cancel !== undefined) signal?.removeEventListener("abort", cancel);
            stream.close();
        }
    };
    return { snapshot, watch };
}
