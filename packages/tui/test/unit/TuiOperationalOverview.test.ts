import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    type OperationalOverview,
} from "@portable-devshell/shared";

import {
    buildTuiHitRegions,
    hitTargetAt,
    selectMainBoxFlowMetrics,
    selectMainBoxIds,
    selectMainScreenModel,
    selectMainScrollKey,
    selectTuiOverviewPresentation,
    TuiAppStore,
    TuiCommandDispatcherNavigation,
    type TuiCommandDispatcherFocus,
    type TuiFocusManager,
    tuiViewProjection,
} from "../../src/testing.ts";

const overview: OperationalOverview = {
    activity: [
        {
            callId: "call-1",
            errorSummary: "worker timed out",
            instance: asInstanceName("alpha"),
            source: "mcp",
            startedAt: "2026-07-31T00:20:00.000Z",
            status: "failed",
            toolName: "bash_run",
        },
    ],
    alerts: [
        {
            detail: "reverse worker disconnected",
            id: "instance.failed:alpha",
            instance: asInstanceName("alpha"),
            kind: "instance.failed",
            severity: "critical",
            title: "Instance failed",
        },
    ],
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
            memoryTotalBytes: 1_000,
        },
        uptimeSeconds: 3_720,
    },
    counts: {
        activeTodos: 1,
        failedCalls24h: 1,
        instancesAttention: 0,
        instancesCritical: 1,
        instancesReady: 0,
        instancesTotal: 1,
        pendingApprovals: 1,
    },
    generatedAt: "2026-07-31T00:30:00.000Z",
    health: "critical",
    instances: [
        {
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
                status: "failed",
            },
            worker: {
                capabilities: { cancel: true, streaming: true, tools: true },
                platform: {
                    arch: "x64",
                    distribution: { id: "arch", name: "Arch Linux" },
                    os: "linux",
                    packageManager: "pacman",
                    shell: {
                        executable: "/bin/bash",
                        kind: "bash",
                        version: "5.3",
                    },
                },
                protocolVersion: 2,
                version: "0.4.10",
            },
            workspace: "/workspace/alpha",
        },
    ],
    todos: [
        {
            completed: 1,
            currentItem: "Restore worker connection",
            instance: asInstanceName("alpha"),
            revision: 2,
            status: "blocked",
            taskId: "task-1",
            title: "Recover remote worker",
            total: 3,
        },
    ],
};

test("overview projects system meters and an instance table without expandable boxes", () => {
    const store = new TuiAppStore();
    store.patchControlReadModel({ overview: overview });
    store.setSelectedPage("overview");
    store.setMainFocusId("overview-instance:alpha");

    const screen = selectMainScreenModel(store.getState());
    const presentation = selectTuiOverviewPresentation(store.getState());
    assert.equal(screen.activePage.instance, undefined);
    assert.deepEqual(screen.boxes, []);
    assert.equal(screen.loadState.kind, "ready");
    assert.equal(presentation.health, "critical");
    assert.deepEqual(
        presentation.meters.map((meter) => [meter.label, meter.percent]),
        [
            ["CPU", 12.5],
            ["Memory", 25],
            ["Disk", 40],
        ],
    );
    assert.deepEqual(
        presentation.instances.map((instance) => ({
            approvals: instance.approvals,
            focused: instance.focused,
            id: instance.id,
            runtime: instance.runtime,
            todos: instance.todos,
            tone: instance.tone,
        })),
        [
            {
                approvals: 1,
                focused: true,
                id: "overview-instance:alpha",
                runtime: "failed",
                todos: 1,
                tone: "danger",
            },
        ],
    );
    assert.equal(presentation.alerts.length, 1);
    assert.equal(presentation.activity[0]?.toolName, "bash_run");
    assert.deepEqual(selectMainBoxIds(store.getState()), [
        "overview-instance:alpha",
    ]);
    const flow = selectMainBoxFlowMetrics(store.getState());
    assert.deepEqual(flow.boxRanges, {
        "overview-instance:alpha": { end: 1, start: 0 },
    });
    assert.equal(flow.scrollKey, selectMainScrollKey(store.getState()));
    assert.match(flow.scrollKey, /^overview/u);
});

test("overview Enter opens the selected instance row", () => {
    const store = new TuiAppStore();
    store.patchControlReadModel({ instances: [
        { enabled: true, mcpEnabled: true, name: "alpha", provider: "local" },
    ] });
    store.patchControlReadModel({ overview: overview });
    store.setSelectedPage("overview");
    store.setFocusScope("mainBoxes");
    store.setMainFocusId("overview-instance:alpha");
    const navigation = new TuiCommandDispatcherNavigation({
        focus: { syncMainFocus() {} } as unknown as TuiCommandDispatcherFocus,
        focusManager: {} as unknown as TuiFocusManager,
        async onLogsReload() {},
        async onPageReload() {},
        onRedraw() {},
        projection: tuiViewProjection,
        store,
    });

    assert.equal(navigation.openFocusedRoute(), true);
    assert.equal(store.getState().ui.selectedPage, "instances");
    assert.equal(store.getState().ui.selectedInstance, "alpha");
    assert.equal(store.getState().ui.mainFocusId, "instance:alpha");
});

test("overview exposes mouse hit regions for visible instance rows", () => {
    const store = new TuiAppStore();
    store.patchControlReadModel({ overview: overview });
    store.setSelectedPage("overview");

    const region = buildTuiHitRegions(store.getState(), {
        columns: 120,
        rows: 40,
    }).find((candidate) => candidate.target.kind === "overviewInstance");
    assert.ok(region !== undefined);
    assert.deepEqual(region.target, {
        instance: "alpha",
        kind: "overviewInstance",
    });
    assert.deepEqual(hitTargetAt([region], region.x, region.y), region.target);
});
