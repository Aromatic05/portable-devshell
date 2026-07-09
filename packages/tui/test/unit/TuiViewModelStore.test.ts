import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";

import { TuiViewModelStore } from "../../dist/index.js";

test("TuiViewModelStore expresses connection, snapshot, log, audit, approval, and config state", () => {
    const store = new TuiViewModelStore();

    store.setConnectionState("connected");
    store.resetInstances([{ mcpEnabled: true, name: "alpha" }]);
    store.setConfigView({
        instances: [{ name: "alpha", security: { mode: "workspace" } }],
        version: 1
    });
    store.upsertSnapshot({
        connectionState: "connected",
        daemonState: "running",
        lastSeq: 1,
        name: asInstanceName("alpha"),
        ready: false,
        status: "running"
    });
    store.replaceToolCalls("alpha", [
        {
            callId: "call-history",
            completedAt: "2026-07-09T00:00:01.000Z",
            exitCode: 0,
            inputSummary: "{\"command\":\"pwd\"}",
            instance: asInstanceName("alpha"),
            source: "tui",
            startedAt: "2026-07-09T00:00:00.000Z",
            status: "completed",
            stderrBytes: 0,
            stdoutBytes: 8,
            timedOut: false,
            toolName: "bash_run"
        }
    ]);
    store.replaceApprovals("alpha", [
        {
            approvalId: "approval-history",
            callId: "call-pending",
            createdAt: "2026-07-09T00:00:02.000Z",
            expiresAt: "2026-07-09T00:05:02.000Z",
            inputSummary: "{\"command\":\"rm -rf\"}",
            instance: asInstanceName("alpha"),
            reason: "Approval required before running bash_run.",
            riskLevel: "high",
            source: "tui",
            status: "pending",
            toolName: "bash_run"
        }
    ]);

    store.applyEvent({
        event: "instance.readyChanged",
        payload: {
            at: "2026-07-09T00:00:03.000Z",
            data: {
                connectionState: "connected",
                daemonState: "running",
                ready: true,
                status: "ready"
            },
            instanceName: "alpha",
            seq: 2,
            type: "instance.readyChanged"
        },
        seq: 2,
        target: { instance: "alpha", kind: "instance" },
        type: "event"
    });
    store.applyEvent({
        event: "toolCall.running",
        payload: {
            at: "2026-07-09T00:00:04.000Z",
            data: {
                callId: "call-live",
                inputSummary: "{\"command\":\"ls\"}",
                requestId: "req-1",
                sessionId: "session-1",
                source: "tui",
                startedAt: "2026-07-09T00:00:04.000Z",
                status: "running",
                toolName: "bash_run"
            },
            instanceName: "alpha",
            seq: 3,
            type: "toolCall.running"
        },
        seq: 3,
        target: { instance: "alpha", kind: "instance" },
        type: "event"
    });
    store.applyEvent({
        event: "log.appended",
        payload: {
            at: "2026-07-09T00:00:05.000Z",
            data: {
                bytes: 12,
                callId: "call-live",
                preview: "stdout line\n",
                requestId: "req-1",
                sessionId: "session-1",
                source: "tui",
                stream: "stdout",
                tail: "stdout line\n",
                toolName: "bash_run"
            },
            instanceName: "alpha",
            seq: 4,
            type: "log.appended"
        },
        seq: 4,
        target: { instance: "alpha", kind: "instance" },
        type: "event"
    });

    const view = store.snapshot();

    assert.equal(view.connection.state, "connected");
    assert.equal(view.instances[0]?.snapshot?.ready, true);
    assert.equal(view.logs[0]?.stream, "stdout");
    assert.equal(view.logs[0]?.callId, "call-live");
    assert.equal(view.toolAudit.some((record) => record.callId === "call-history"), true);
    assert.equal(view.toolAudit.some((record) => record.callId === "call-live" && record.status === "running"), true);
    assert.equal(view.approvals[0]?.approvalId, "approval-history");
    assert.equal((view.config?.version as number | undefined) ?? 0, 1);
});
