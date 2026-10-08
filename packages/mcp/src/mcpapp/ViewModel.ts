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
import type { McpAppSnapshot, McpAppWorkItem } from "./model/Contract.js";

/** Present authoritative Instance snapshots without retaining another domain state. */
export function projectMcpAppSnapshot(input: {
    approvals: { approvals: ApprovalRequest[]; lastSeq: number };
    ctxId: string;
    goals: { goals: GoalSnapshot[]; lastSeq: number };
    instance: string;
    todo: { todo: TodoReadResult; lastSeq: number };
    waits?: { waits: WaitRecord[]; lastSeq: number };
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
        cursor: Math.min(input.approvals.lastSeq, input.goals.lastSeq, input.todo.lastSeq, input.waits?.lastSeq ?? Number.MAX_SAFE_INTEGER),
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
        reentry: { pending: false },
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
export function createMcpAppViewModel(endpoint: Endpoint) {
    const snapshot = async (instance: string, ctxId: string, workspace?: string) => {
        const task = createTaskTransport(endpoint, instance);
        const approval = createApprovalTransport(endpoint, instance);
        const [goals, todo, approvals, waits] = await Promise.all([
            task.getGoals(), task.getTodo(), approval.snapshot({ pendingOnly: true }), task.getWaits(ctxId),
        ]);
        return projectMcpAppSnapshot({
            approvals, ctxId, goals, instance, todo, waits,
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
            if (result === "timeout" || result === "aborted")
                return { changed: false, cursor };
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
