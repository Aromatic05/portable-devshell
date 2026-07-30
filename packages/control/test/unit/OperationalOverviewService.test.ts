import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    type ActiveTodoSummary,
    type ToolCallRecord
} from "@portable-devshell/shared";

import { OperationalOverviewService } from "../../src/control/overview/OperationalOverviewService.ts";
import {
    createTestInstanceDescriptor,
    createTestTodoPort
} from "../ControlTestFixtures.ts";

const now = new Date("2026-07-31T00:00:00.000Z");

test("operational overview prioritizes failures, approvals, activity, and todos without raw payloads", async () => {
    const blockedTodo: ActiveTodoSummary = {
        completed: 1,
        currentItem: "Waiting for worker package",
        revision: 4,
        status: "blocked",
        taskId: "task-1",
        title: "Upgrade worker",
        total: 3
    };
    const failedCall: ToolCallRecord = {
        callId: "call-1",
        completedAt: "2026-07-30T23:30:00.000Z",
        error: "secret=should-not-expand\nworker failed",
        input: { command: "private command" },
        inputSummary: "private command",
        instance: asInstanceName("ready-one"),
        output: { token: "private output" },
        source: "mcp",
        startedAt: "2026-07-30T23:29:00.000Z",
        status: "failed",
        toolName: "bash_run"
    };
    const ready = createTestInstanceDescriptor({
        listApprovals: async () => [{ id: "approval-1" }],
        readToolCalls: async () => [failedCall],
        snapshot: () => ({
            connectionState: "connected",
            daemonState: "running",
            lastSeq: 7,
            name: asInstanceName("ready-one"),
            ready: true,
            status: "ready"
        })
    } as never, {
        mcpEnabled: true,
        name: "ready-one",
        provider: "local",
        todo: {
            ...createTestTodoPort(),
            summaries: () => [blockedTodo]
        },
        workspace: "/workspace"
    });
    const failed = createTestInstanceDescriptor({
        listApprovals: async () => [],
        readToolCalls: async () => [],
        snapshot: () => ({
            connectionState: "failed",
            daemonState: "failed",
            lastErrorMessage: "reverse worker disconnected",
            lastSeq: 2,
            name: asInstanceName("failed-one"),
            ready: false,
            status: "failed"
        })
    } as never, {
        name: "failed-one",
        provider: "reverse"
    });
    const overview = await new OperationalOverviewService({
        instances: { list: () => [ready, failed] },
        now: () => now,
        oauthApprovals: () => ({ list: async () => [{ id: "oauth-1" }] }),
        processId: () => 42,
        uptimeSeconds: () => 90.8
    }).read();

    assert.equal(overview.health, "critical");
    assert.deepEqual(overview.controller, { pid: 42, uptimeSeconds: 90 });
    assert.deepEqual(overview.counts, {
        activeTodos: 1,
        failedCalls24h: 1,
        instancesAttention: 0,
        instancesCritical: 1,
        instancesReady: 1,
        instancesTotal: 2,
        pendingApprovals: 2
    });
    assert.equal(overview.alerts[0]?.severity, "critical");
    assert.ok(overview.alerts.some((alert) => alert.kind === "approval.oauthPending"));
    assert.ok(overview.alerts.some((alert) => alert.kind === "todo.blocked"));
    assert.deepEqual(overview.activity, [{
        callId: "call-1",
        completedAt: "2026-07-30T23:30:00.000Z",
        errorSummary: "secret=should-not-expand worker failed",
        instance: asInstanceName("ready-one"),
        source: "mcp",
        startedAt: "2026-07-30T23:29:00.000Z",
        status: "failed",
        toolName: "bash_run"
    }]);
    assert.equal("input" in overview.activity[0]!, false);
    assert.equal("output" in overview.activity[0]!, false);
});

test("operational overview remains available when one collection source fails", async () => {
    const descriptor = createTestInstanceDescriptor({
        listApprovals: async () => {
            throw new Error("approval store unavailable");
        },
        readToolCalls: async () => {
            throw new Error("audit store unavailable");
        },
        snapshot: () => ({
            connectionState: "connected",
            daemonState: "running",
            lastSeq: 1,
            name: asInstanceName("local-one"),
            ready: true,
            status: "ready"
        })
    } as never, { name: "local-one" });

    const overview = await new OperationalOverviewService({
        instances: { list: () => [descriptor] },
        now: () => now
    }).read();

    assert.equal(overview.health, "attention");
    assert.equal(overview.instances.length, 1);
    assert.deepEqual(
        overview.alerts.map((alert) => alert.kind),
        ["overview.partial", "overview.partial"]
    );
});
