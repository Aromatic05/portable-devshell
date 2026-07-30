import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    type OperationalOverview
} from "@portable-devshell/shared";

import {
    selectMainScreenModel,
    selectMainScrollKey,
    TuiAppStore,
    TuiKeyDispatcher
} from "../../src/testing.ts";

const overview: OperationalOverview = {
    activity: [{
        callId: "call-1",
        errorSummary: "worker timed out",
        instance: asInstanceName("alpha"),
        source: "mcp",
        startedAt: "2026-07-31T00:20:00.000Z",
        status: "failed",
        toolName: "bash_run"
    }],
    alerts: [{
        detail: "reverse worker disconnected",
        id: "instance.failed:alpha",
        instance: asInstanceName("alpha"),
        kind: "instance.failed",
        severity: "critical",
        title: "Instance failed"
    }],
    controller: {
        pid: 42,
        system: {
            cpuCount: 8,
            cpuPercent: 12.5,
            diskAvailableBytes: 600,
            diskPath: "/home/aromatic",
            diskPercent: 40,
            diskTotalBytes: 1_000,
            load1m: 1.25,
            memoryAvailableBytes: 750,
            memoryPercent: 25,
            memoryTotalBytes: 1_000
        },
        uptimeSeconds: 3_720
    },
    counts: {
        activeTodos: 1,
        failedCalls24h: 1,
        instancesAttention: 0,
        instancesCritical: 1,
        instancesReady: 0,
        instancesTotal: 1,
        pendingApprovals: 1
    },
    generatedAt: "2026-07-31T00:30:00.000Z",
    health: "critical",
    instances: [{
        mcpEnabled: true,
        name: asInstanceName("alpha"),
        pendingApprovals: 1,
        provider: "reverse",
        snapshot: {
            connectionState: "failed",
            daemonState: "failed",
            lastErrorMessage: "reverse worker disconnected",
            lastSeq: 7,
            name: asInstanceName("alpha"),
            ready: false,
            status: "failed"
        },
        worker: {
            capabilities: { cancel: true, streaming: true, tools: true },
            platform: {
                arch: "x64",
                distribution: { id: "arch", name: "Arch Linux" },
                os: "linux",
                packageManager: "pacman",
                shell: { executable: "/bin/bash", kind: "bash", version: "5.3" }
            },
            protocolVersion: 2,
            version: "0.4.10"
        },
        workspace: "/workspace/alpha"
    }],
    todos: [{
        completed: 1,
        currentItem: "Restore worker connection",
        instance: asInstanceName("alpha"),
        revision: 2,
        status: "blocked",
        taskId: "task-1",
        title: "Recover remote worker",
        total: 3
    }]
};

test("overview page prioritizes health and alerts before read-only operational detail", () => {
    const store = new TuiAppStore();
    store.replaceOperationalOverview(overview);
    store.setSelectedPage("overview");

    const model = selectMainScreenModel(store.getState());
    assert.equal(model.activePage.instance, undefined);
    assert.deepEqual(
        model.boxes.map((box) => box.title),
        [
            "Operational Health",
            "Alert · Instance failed",
            "Instance · alpha",
            "Activity · bash_run",
            "Todo · Recover remote worker"
        ]
    );
    assert.equal(model.boxes[0]?.status, "failed");
    assert.equal(
        model.boxes[0]?.expandedLines.some((line) => line.text.includes("CPU") && line.text.includes("12.5%")),
        true
    );
    assert.equal(
        model.boxes[0]?.expandedLines.some((line) => line.text.includes("Memory") && line.text.includes("25%")),
        true
    );
    assert.equal(
        model.boxes[0]?.expandedLines.some((line) => line.text.includes("Disk") && line.text.includes("40%")),
        true
    );
    assert.equal(model.boxes[1]?.severity, "danger");
    assert.equal(
        model.boxes[2]?.expandedLines.some((line) => line.text.includes("0.4.10") && line.text.includes("protocol 2")),
        true
    );
    assert.equal(
        model.boxes[2]?.expandedLines.some((line) => line.text.includes("linux/x64")),
        true
    );
    assert.equal(
        model.boxes[2]?.expandedLines.some((line) => line.text.includes("tools, streaming, cancel")),
        true
    );
    assert.equal(selectMainScrollKey(store.getState()), "overview:-:main");
    const actions = model.boxes.flatMap((box) =>
        box.expandedLines.flatMap((line) => line.id?.includes(":button:") ? [line.id] : [])
    );
    assert.equal(actions.length > 0, true);
    assert.equal(actions.every((id) => id.includes(":button:overview-open-")), true);
});

test("overview uses zero without changing the established one-to-nine page shortcuts", () => {
    const dispatcher = new TuiKeyDispatcher();
    assert.deepEqual(
        dispatcher.dispatch("sidebarPages", { input: "0", key: {} }),
        [{ page: "overview", type: "page.select" }]
    );
    assert.deepEqual(
        dispatcher.dispatch("sidebarPages", { input: "1", key: {} }),
        [{ page: "instances", type: "page.select" }]
    );
    assert.deepEqual(
        dispatcher.dispatch("sidebarPages", { input: "9", key: {} }),
        [{ page: "terminal", type: "page.select" }]
    );
});
