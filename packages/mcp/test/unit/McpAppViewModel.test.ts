import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovalRequest, GoalSnapshot, TodoTaskSummary } from "@portable-devshell/shared";
import { projectMcpAppSnapshot } from "../../src/mcpapp/ViewModel.ts";

test("MCP App ViewModel isolates Context approvals and tasks, and workspace goals", () => {
    const goal = (goalId: string, workspace: string): GoalSnapshot => ({
        goalId, workspace, objective: goalId, status: "active", steps: [],
        continuationDue: false, continuationDueAt: "", continuationPending: false,
        continuationUncertain: false, continuationCount: 0, autoContinueExhausted: false,
        createdAt: "", updatedAt: "", lastAgentActivityAt: "", lastProgressAt: "",
        revision: 1,
    });
    const task = (taskId: string, ctxId: string): TodoTaskSummary => ({
        taskId, ctxId, title: taskId, status: "in_progress", completed: 1,
        total: 2, revision: 1, updatedAt: "",
    });
    const approval = (approvalId: string, ctxId: string): ApprovalRequest => ({
        approvalId, ctxId, callId: approvalId, createdAt: "", expiresAt: "",
        inputSummary: approvalId, instance: "test" as ApprovalRequest["instance"],
        reason: "", riskLevel: "low", source: "mcp", status: "pending", toolName: "bash_run",
    });
    const snapshot = projectMcpAppSnapshot({
        ctxId: "ctx-a",
        instance: "test",
        workspace: "/allowed",
        approvals: { approvals: [approval("allowed", "ctx-a"), approval("secret", "ctx-b")], lastSeq: 15 },
        goals: { goals: [goal("allowed-goal", "/allowed"), goal("secret-goal", "/other")], lastSeq: 12 },
        todo: {
            lastSeq: 17,
            todo: {
                revision: 1, summary: { completed: 0, total: 0 }, items: [],
                tasks: [task("allowed-task", "ctx-a"), task("secret-task", "ctx-b")],
            },
        },
    });
    assert.equal(snapshot.cursor, 12);
    assert.equal(snapshot.presentation.primary?.id, "allowed");
    assert.deepEqual(snapshot.presentation.work.map((entry) => entry.id), ["allowed-goal", "allowed-task"]);
    assert.equal(snapshot.presentation.work.every((entry) => entry.actions.length === 0), true);
    assert.equal(JSON.stringify(snapshot).includes("secret"), false);
    assert.equal(snapshot.reentry.pending, false);
});

test("MCP App ViewModel hides all workspace goals when Context has no matching workspace", () => {
    const snapshot = projectMcpAppSnapshot({
        ctxId: "ctx-a", instance: "test", approvals: { approvals: [], lastSeq: 0 },
        goals: { goals: [{ goalId: "secret", workspace: "/other" } as GoalSnapshot], lastSeq: 0 },
        todo: { todo: { items: [], summary: { completed: 0, total: 0 }, revision: 0 }, lastSeq: 0 },
    });
    assert.deepEqual(snapshot.presentation.work, []);
    assert.equal(JSON.stringify(snapshot).includes("secret"), false);
});
