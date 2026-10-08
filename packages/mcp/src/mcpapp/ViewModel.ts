import type {
    ApprovalRequest,
    GoalSnapshot,
    TodoReadResult,
} from "@portable-devshell/shared";
import { mcpAppModelContext } from "./ModelContext.js";
import type { McpAppSnapshot, McpAppWorkItem } from "./model/Contract.js";

/** Present authoritative Instance snapshots without retaining another domain state. */
export function projectMcpAppSnapshot(input: {
    approvals: { approvals: ApprovalRequest[]; lastSeq: number };
    ctxId: string;
    goals: { goals: GoalSnapshot[]; lastSeq: number };
    instance: string;
    todo: { todo: TodoReadResult; lastSeq: number };
    workspace?: string;
}): McpAppSnapshot {
    // A goal is workspace-owned, while approvals and Todo tasks carry Context IDs.
    // Never infer permission to read another Context's records from the Instance name.
    const goals = input.workspace === undefined
        ? []
        : input.goals.goals.filter((goal) => goal.workspace === input.workspace);
    const approvals = input.approvals.approvals.filter((entry) =>
        entry.ctxId === input.ctxId && entry.status === "pending",
    );
    const tasks = (input.todo.todo.tasks ?? []).filter((task) => task.ctxId === input.ctxId);
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
                actions: [],
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
                actions: [],
            })),
    ];
    const snapshot: McpAppSnapshot = {
        ctxId: input.ctxId,
        instance: input.instance,
        // Each authority captured a cursor before its read. Starting at their
        // minimum means changes racing with any read cannot be missed.
        cursor: Math.min(input.approvals.lastSeq, input.goals.lastSeq, input.todo.lastSeq),
        agentBusy: work.some((item) => item.state === "running"),
        presentation: {
            ...(approvals[0] === undefined ? {} : {
                primary: {
                    kind: "decision",
                    id: approvals[0].approvalId,
                    title: "Approval required",
                    summary: approvals[0].toolName,
                    detail: approvals[0].inputSummary,
                    actions: [],
                },
            }),
            work,
            background: [],
        },
        modelContext: {
            content: [],
            structuredContent: { portableDevshellMcpApp: null },
        },
        reentry: { pending: false },
    };
    snapshot.modelContext = mcpAppModelContext(snapshot, {
        ...(goals[0] === undefined ? {} : { goal: goals[0] }),
        tasks,
        background: [],
    });
    return snapshot;
}
