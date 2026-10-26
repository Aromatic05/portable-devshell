import {
    createArtifactTransport,
    createApprovalTransport,
    createInstanceRuntimeTransport,
    createProcessTransport,
    createTaskTransport,
    createToolTransport,
    type Endpoint,
    type ApprovalRequest,
    type GoalSnapshot,
    type WaitRecord,
    type InstanceEventRecord,
} from "@portable-devshell/shared";
import { mcpAppModelContext } from "./ModelContext.js";
import { readMcpAppActivity, readMcpAppActivityImage, readMcpAppActivityOutput } from "./Activity.js";
import { projectMcpAppReentry } from "./ReentryView.js";
import type { McpAppActionStore } from "./ActionStore.js";
import type { McpAppReentryDirective, McpAppSnapshot, McpAppWorkItem } from "./model/Contract.js";

/** Present authoritative Instance snapshots without retaining another domain state. */
export function projectMcpAppSnapshot(input: {
    approvals: { approvals: ApprovalRequest[]; lastSeq: number };
    ctxId: string;
    goal: { goal: GoalSnapshot | null; lastSeq: number };
    instance: string;
    agentBusy?: boolean;
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
                actions: [
                    goal.status === "active"
                        ? { id: "goal-pause", label: "Pause", expectedRevision: goal.revision }
                        : { id: "goal-resume", label: "Resume", expectedRevision: goal.revision },
                    { id: "goal-stop", label: "Stop", tone: "danger" as const,
                        confirmation: { message: "Stop this Goal?" }, expectedRevision: goal.revision },
                ],
            })),
    ];
    const snapshot: McpAppSnapshot = {
        ctxId: input.ctxId,
        instance: input.instance,
        // Each authority captured a cursor before its read. Starting at their
        // minimum means changes racing with any read cannot be missed.
        cursor: Math.min(input.approvals.lastSeq, input.goal.lastSeq, input.waits?.lastSeq ?? Number.MAX_SAFE_INTEGER),
        agentBusy: input.agentBusy ?? false,
        presentation: {
            pendingApprovals: approvals.length,
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
        reentry: projectMcpAppReentry({ mode: "automatic" }, goals[0], input.agentBusy ?? false, input.directives),
    };
    snapshot.modelContext = mcpAppModelContext(snapshot, {
        ...(goals[0] === undefined ? {} : { goal: goals[0] }),
        tasks: [],
        background: waits.map((wait) => ({
            kind: "tmux", status: wait.status, targetId: wait.targetId,
            detachedAt: wait.createdAt,
        })),
    });
    return snapshot;
}

/** Reads existing Instance authorities; holds no independent workspace state. */
export function mcpAppEventAffectsContext(event: InstanceEventRecord, ctxId: string): boolean {
    // These event families are emitted with their owning Context ID. Unknown
    // and Instance-global events conservatively trigger an authoritative read.
    if (event.type !== "goal.updated" && event.type !== "log.appended" && !event.type.startsWith("wait.") &&
        !event.type.startsWith("toolCall.")) return true;
    const data = event.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) return true;
    return typeof data.ctxId !== "string" || data.ctxId === ctxId;
}

export function createMcpAppViewModel(endpoint: Endpoint, actions?: McpAppActionStore) {
    const snapshot = async (instance: string, ctxId: string, workspace?: string) => {
        const task = createTaskTransport(endpoint, instance);
        const approval = createApprovalTransport(endpoint, instance);
        const [goal, approvals, waits, directives] = await Promise.all([
            task.getGoal(ctxId), approval.snapshot({ pendingOnly: true }), task.getWaits(ctxId),
            actions?.pendingDirectives(ctxId, instance) ?? Promise.resolve([]),
        ]);
        const tools = createToolTransport(endpoint, instance);
        let agentBusy = true;
        // UI, Goal control and reporting calls are not Agent execution.
        // Continue automatically only when the running set proves idle.
        try {
            const running = await tools.listCalls({
                ctxId, status: "running", limit: 64, includeInput: false,
                includeOutput: false,
            });
            // This is a mutable active set, not a stable history snapshot. A
            // page boundary can finish and disappear before the next read.
            // A full page cannot prove idle, even if it contains only UI calls.
            // A later snapshot/watch restores ready only once an unfilled
            // authoritative page contains no Agent execution.
            agentBusy = running.length >= 64 || running.some((call) =>
                call.ctxId === ctxId && call.status === "running" &&
                call.source !== "extension" &&
                !["workspace_goal", "progress_report", "environ_info"].includes(call.toolName) &&
                !call.toolName.startsWith("mcpapp_"));
        } catch {
            // An unavailable execution authority cannot prove recovery is safe.
        }
        const projected = projectMcpAppSnapshot({
            approvals, ctxId, goal, instance, waits, directives, agentBusy,
            ...(workspace === undefined ? {} : { workspace }),
        });
        return projected;
    };
    const activity = (instance: string, ctxId: string) =>
        readMcpAppActivity(createToolTransport(endpoint, instance), ctxId);
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
                // A Wait can commit while Audit delivery is temporarily
                // unavailable. Poll authoritative state even without events.
                const due = await snapshot(instance, ctxId, workspace);
                due.cursor = Math.max(due.cursor, cursor);
                return { changed: true, cursor: due.cursor, snapshot: due };
            }
            if (result.kind === "closed")
                throw result.error ?? new Error("Instance Event stream closed unexpectedly.");
            // An event not relevant to this Context must still advance the
            // cursor. Otherwise the next watch replays the same event forever.
            const observed = result.kind === "event" ? result.event.seq : result.gap.lastSeq;
            if (result.kind === "event" && !mcpAppEventAffectsContext(result.event, ctxId))
                return { changed: false, cursor: Math.max(observed, cursor) };
            const next = await snapshot(instance, ctxId, workspace);
            next.cursor = Math.max(next.cursor, observed, cursor);
            return { changed: true, cursor: next.cursor, snapshot: next };
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            if (cancel !== undefined) signal?.removeEventListener("abort", cancel);
            stream.close();
        }
    };
    const activityOutput = (instance: string, ctxId: string, callId: string, fromSeq = 1) =>
        readMcpAppActivityOutput(createToolTransport(endpoint, instance),
            createProcessTransport(endpoint, instance), ctxId, callId, fromSeq);
    const activityImage = (instance: string, ctxId: string, callId: string) =>
        readMcpAppActivityImage(createToolTransport(endpoint, instance),
            createArtifactTransport(endpoint), ctxId, callId);
    return { snapshot, watch, activity, activityOutput, activityImage };
}
