import assert from "node:assert/strict";
import test from "node:test";

import {
    Endpoint,
    Rpc,
    asInstanceName,
    normalizeConfigInstanceDraft,
    type ControlInstanceConfig,
    type InstanceProcessEnvelope,
    type InstanceSnapshot,
    type InstanceWorkerInfo,
    type OAuthApprovalRequest,
    type ToolCallRecord,
    type TodoTaskSummary,
} from "@portable-devshell/shared";
import { Instance } from "@portable-devshell/core";
import { OperationalOverviewInstanceCollector } from "../../../src/overview/collector/Instance.ts";
import { createTestInstance } from "../../support/InstanceRuntime.ts";

import { createOperationalOverviewRuntime } from "../../../src/overview/index.ts";

const now = new Date("2026-07-31T00:00:00.000Z");
const healthySystemCollector = {
    async collect() {
        return {
            alerts: [],
            system: {
                cpuCount: 1,
                memoryAvailableBytes: 1,
                memoryPercent: 0,
                memoryTotalBytes: 1,
            },
        };
    },
};

function instance(
    name: string,
    options: {
        mcpEnabled?: boolean;
        provider?: ControlInstanceConfig["provider"];
    } = {},
): Instance {
    return createTestInstance(
        normalizeConfigInstanceDraft({
            enabled: true,
            mcp: { enabled: options.mcpEnabled ?? false },
            name,
            provider: options.provider ?? "local",
        }),
    );
}

interface OverviewEndpointInstance {
    approvals?: () => unknown[];
    calls?: (query: unknown) => ToolCallRecord[];
    failures?: (
        sinceMs: number,
        untilMs: number,
    ) => { count: number; latest?: ToolCallRecord };
    snapshot: () => InstanceProcessEnvelope;
    todo?: () => unknown;
}

function processEnvelope(
    snapshot: InstanceSnapshot,
    worker?: InstanceWorkerInfo,
): InstanceProcessEnvelope {
    return {
        lastSeq: snapshot.lastSeq,
        snapshot,
        ...(worker === undefined ? {} : { worker }),
    };
}

function todoEnvelope(tasks: readonly TodoTaskSummary[] = []): unknown {
    return {
        lastSeq: 0,
        todo: {
            items: [],
            revision: 0,
            summary: { completed: 0, total: 0 },
            tasks,
        },
    };
}

function overviewEndpoint(
    instances: Record<string, OverviewEndpointInstance>,
): Endpoint {
    const endpoint = new Endpoint({ host: "control" });
    endpoint.connect = async (host, port) =>
        endpoint.bind(`client-${host}-${port}`).connect(host, port);
    for (const [name, data] of Object.entries(instances)) {
        const host = asInstanceName(name);
        new Rpc(endpoint.bind("process", host), {
            snapshot: () => data.snapshot(),
        });
        new Rpc(endpoint.bind("approval", host), {
            list: () => data.approvals?.() ?? [],
        });
        new Rpc(endpoint.bind("task", host), {
            getTodo: () => data.todo?.() ?? todoEnvelope(),
        });
        new Rpc(endpoint.bind("tool", host), {
            listCalls: (payload) => data.calls?.(payload) ?? [],
            failureSummary: (payload) => {
                const window = payload as { sinceMs: number; untilMs: number };
                return (
                    data.failures?.(window.sinceMs, window.untilMs) ?? {
                        count: 0,
                    }
                );
            },
        });
    }
    return endpoint;
}

function collector(endpoint: Endpoint): OperationalOverviewInstanceCollector {
    return new OperationalOverviewInstanceCollector({
        activityLimit: 20,
        endpoint,
    });
}

test("operational overview prioritizes failures, approvals, activity, and todos without raw payloads", async () => {
    const blockedTodo: TodoTaskSummary = {
        completed: 1,
        currentItem: "Waiting for worker package",
        revision: 4,
        status: "blocked",
        taskId: "task-1",
        title: "Upgrade worker",
        total: 3,
        updatedAt: "2026-07-30T23:00:00.000Z",
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
        toolName: "bash_run",
    };
    const ready = instance("ready-one", { mcpEnabled: true, provider: "local" });
    const failed = instance("failed-one", { provider: "reverse" });
    const endpoint = overviewEndpoint({
        "ready-one": {
            approvals: () => [{ id: "approval-1" }],
            calls: () => [failedCall],
            failures: () => ({ count: 1, latest: failedCall }),
            snapshot: () =>
                processEnvelope(
                    {
                        connectionState: "connected",
                        daemonState: "running",
                        lastSeq: 7,
                        name: asInstanceName("ready-one"),
                        ready: true,
                        status: "ready",
                    },
                    {
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
                        protocolVersion: "2",
                        version: "0.4.10",
                    },
                ),
            todo: () => todoEnvelope([blockedTodo]),
        },
        "failed-one": {
            snapshot: () =>
                processEnvelope({
                    connectionState: "failed",
                    daemonState: "failed",
                    lastErrorMessage: "reverse worker disconnected",
                    lastSeq: 2,
                    name: asInstanceName("failed-one"),
                    ready: false,
                    status: "failed",
                }),
        },
    });
    const overview = await createOperationalOverviewRuntime({
        instanceCollector: collector(endpoint),
        instances: { list: () => [ready, failed] },
        now: () => now,
        oauthApprovals: () => ({
            list: async () => [
                oauthApproval("oauth-pending", "pending"),
                oauthApproval("oauth-approved", "approved"),
                oauthApproval("oauth-denied", "denied"),
            ],
        }),
        processId: () => 42,
        systemCollector: {
            async collect() {
                return {
                    alerts: [],
                    system: {
                        cpuCount: 8,
                        cpuPercent: 12.5,
                        load1m: 1.25,
                        memoryAvailableBytes: 750,
                        memoryPercent: 25,
                        memoryTotalBytes: 1_000,
                    },
                };
            },
        },
        uptimeSeconds: () => 90.8,
    }).read();

    assert.equal(overview.health, "critical");
    assert.deepEqual(overview.controller, {
        pid: 42,
        system: {
            cpuCount: 8,
            cpuPercent: 12.5,
            load1m: 1.25,
            memoryAvailableBytes: 750,
            memoryPercent: 25,
            memoryTotalBytes: 1_000,
        },
        uptimeSeconds: 90,
    });
    assert.deepEqual(overview.counts, {
        activeTodos: 1,
        failedCalls24h: 1,
        instancesAttention: 0,
        instancesCritical: 1,
        instancesReady: 1,
        instancesTotal: 2,
        pendingApprovals: 2,
    });
    assert.equal(overview.alerts[0]?.severity, "critical");
    assert.ok(
        overview.alerts.some((alert) => alert.kind === "approval.oauthPending"),
    );
    assert.ok(overview.alerts.some((alert) => alert.kind === "todo.blocked"));
    assert.deepEqual(overview.activity, [
        {
            callId: "call-1",
            completedAt: "2026-07-30T23:30:00.000Z",
            errorSummary: "secret=should-not-expand worker failed",
            instance: asInstanceName("ready-one"),
            source: "mcp",
            startedAt: "2026-07-30T23:29:00.000Z",
            status: "failed",
            toolName: "bash_run",
        },
    ]);
    assert.equal("input" in overview.activity[0]!, false);
    assert.equal("output" in overview.activity[0]!, false);
    assert.deepEqual(
        overview.instances.find((instance) => instance.name === "ready-one")
            ?.worker,
        {
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
            protocolVersion: "2",
            version: "0.4.10",
        },
    );
});

test("operational overview treats a deliberately stopped instance as neutral while keeping transitional non-ready instances actionable", async () => {
    const stopped = instance("stopped-one");
    const starting = instance("starting-one");
    const endpoint = overviewEndpoint({
        "stopped-one": {
            snapshot: () =>
                processEnvelope({
                    connectionState: "disconnected",
                    daemonState: "stopped",
                    lastSeq: 1,
                    name: asInstanceName("stopped-one"),
                    ready: false,
                    status: "stopped",
                }),
        },
        "starting-one": {
            snapshot: () =>
                processEnvelope({
                    connectionState: "connecting",
                    daemonState: "starting",
                    lastSeq: 2,
                    name: asInstanceName("starting-one"),
                    ready: false,
                    status: "running",
                }),
        },
    });

    const overview = await createOperationalOverviewRuntime({
        instances: { list: () => [stopped, starting] },
        instanceCollector: collector(endpoint),
        now: () => now,
        systemCollector: healthySystemCollector,
    }).read();

    assert.equal(overview.health, "attention");
    assert.deepEqual(overview.counts, {
        activeTodos: 0,
        failedCalls24h: 0,
        instancesAttention: 1,
        instancesCritical: 0,
        instancesReady: 0,
        instancesTotal: 2,
        pendingApprovals: 0,
    });
    assert.deepEqual(
        overview.alerts
            .filter((alert) => alert.kind === "instance.attention")
            .map((alert) => alert.instance),
        [asInstanceName("starting-one")],
    );
});

test("operational overview counts the full 24 hour failure window while bounding activity", async () => {
    const completedCalls: ToolCallRecord[] = Array.from(
        { length: 25 },
        (_, index) => {
            const timestamp = new Date(
                now.getTime() - index * 60_000,
            ).toISOString();
            return {
                callId: `completed-${index}`,
                completedAt: timestamp,
                inputSummary: "completed call",
                instance: asInstanceName("busy-one"),
                source: "mcp",
                startedAt: timestamp,
                status: "completed",
                toolName: "bash_run",
            };
        },
    );
    const olderFailure: ToolCallRecord = {
        callId: "older-failure",
        completedAt: new Date(
            now.getTime() - 23 * 60 * 60 * 1_000,
        ).toISOString(),
        error: "failed before the latest twenty calls",
        inputSummary: "older failed call",
        instance: asInstanceName("busy-one"),
        source: "mcp",
        startedAt: new Date(
            now.getTime() - 23 * 60 * 60 * 1_000 - 1_000,
        ).toISOString(),
        status: "failed",
        toolName: "bash_run",
    };
    const futureFailure: ToolCallRecord = {
        ...olderFailure,
        callId: "future-failure",
        completedAt: new Date(now.getTime() + 60_000).toISOString(),
        startedAt: new Date(now.getTime() + 59_000).toISOString(),
    };
    let activityQuery: unknown;
    let failureWindow: [number, number] | undefined;
    const descriptor = instance("busy-one");
    const endpoint = overviewEndpoint({
        "busy-one": {
            snapshot: () =>
                processEnvelope({
                    connectionState: "connected",
                    daemonState: "running",
                    lastSeq: 1,
                    name: asInstanceName("busy-one"),
                    ready: true,
                    status: "ready",
                }),
            failures: (sinceMs, untilMs) => {
                failureWindow = [sinceMs, untilMs];
                return { count: 1, latest: olderFailure };
            },
            calls: (query) => {
                activityQuery = query;
                return [olderFailure, futureFailure, ...completedCalls];
            },
        },
    });

    const overview = await createOperationalOverviewRuntime({
        instances: { list: () => [descriptor] },
        instanceCollector: collector(endpoint),
        now: () => now,
        systemCollector: healthySystemCollector,
    }).read();

    assert.equal(overview.counts.failedCalls24h, 1);
    assert.equal(overview.activity.length, 20);
    assert.equal(
        overview.activity.some(
            (activity) => activity.callId === "older-failure",
        ),
        false,
    );
    assert.equal(overview.activity[0]?.callId, "future-failure");
    assert.deepEqual(activityQuery, {
        includeInput: false,
        includeOutput: false,
        limit: 20,
        maxBytes: 128 * 1024,
    });
    assert.deepEqual(failureWindow, [
        now.getTime() - 24 * 60 * 60 * 1_000,
        now.getTime(),
    ]);
});

test("operational overview coalesces concurrent reads without caching later refreshes", async () => {
    const descriptor = instance("coalesced-one");
    let collectCount = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });
    const service = createOperationalOverviewRuntime({
        instanceCollector: {
            async collect() {
                collectCount += 1;
                if (collectCount === 1) {
                    await firstGate;
                }
                return {
                    activity: [],
                    alerts: [],
                    failedCalls24h: 0,
                    instance: {
                        mcpEnabled: false,
                        name: asInstanceName("coalesced-one"),
                        pendingApprovals: 0,
                        provider: "local",
                        snapshot: {
                            connectionState: "connected",
                            daemonState: "running",
                            lastSeq: 1,
                            name: asInstanceName("coalesced-one"),
                            ready: true,
                            status: "ready",
                        },
                    },
                    todos: [],
                };
            },
        },
        instances: { list: () => [descriptor] },
        now: () => now,
        systemCollector: healthySystemCollector,
    });

    const first = service.read();
    const second = service.read();
    assert.equal(collectCount, 1);
    releaseFirst();
    assert.deepEqual(await first, await second);
    await service.read();
    assert.equal(collectCount, 2);
});

test("controller resource alerts participate in overall health", async () => {
    const service = createOperationalOverviewRuntime({
        instances: { list: () => [] },
        instanceCollector: collector(overviewEndpoint({})),
        now: () => now,
        systemCollector: {
            async collect() {
                return {
                    alerts: [
                        {
                            detail: "96% used",
                            id: "controller.diskPressure",
                            kind: "controller.diskPressure" as const,
                            severity: "critical" as const,
                            title: "Controller disk pressure",
                        },
                    ],
                    system: {
                        cpuCount: 4,
                        diskAvailableBytes: 40,
                        diskPath: "/state",
                        diskPercent: 96,
                        diskTotalBytes: 1_000,
                        memoryAvailableBytes: 500,
                        memoryPercent: 50,
                        memoryTotalBytes: 1_000,
                    },
                };
            },
        },
    });

    const overview = await service.read();

    assert.equal(overview.health, "critical");
    assert.equal(overview.alerts[0]?.kind, "controller.diskPressure");
    assert.equal(overview.controller.system?.diskPercent, 96);
});

test("operational overview isolates snapshot and todo collection failures per instance", async () => {
    const snapshotBroken = instance("snapshot-broken");
    const todoBroken = instance("todo-broken");
    const endpoint = overviewEndpoint({
        "snapshot-broken": {
            snapshot: () => {
                throw new Error("snapshot unavailable");
            },
        },
        "todo-broken": {
            snapshot: () =>
                processEnvelope({
                    connectionState: "connected",
                    daemonState: "running",
                    lastSeq: 1,
                    name: asInstanceName("todo-broken"),
                    ready: true,
                    status: "ready",
                }),
            todo: () => {
                throw new Error("todo store unavailable");
            },
        },
    });

    const overview = await createOperationalOverviewRuntime({
        instanceCollector: collector(endpoint),
        instances: { list: () => [snapshotBroken, todoBroken] },
        now: () => now,
        systemCollector: healthySystemCollector,
    }).read();

    assert.equal(overview.health, "critical");
    assert.equal(overview.instances.length, 2);
    assert.equal(
        overview.instances.find(
            (instance) => instance.name === "snapshot-broken",
        )?.snapshot.status,
        "failed",
    );
    assert.ok(
        overview.alerts.some(
            (alert) =>
                alert.kind === "instance.failed" &&
                alert.instance === "snapshot-broken",
        ),
    );
    assert.ok(
        overview.alerts.some(
            (alert) =>
                alert.kind === "overview.partial" &&
                alert.instance === "todo-broken",
        ),
    );
});

test("operational overview remains available when one collection source fails", async () => {
    const descriptor = instance("local-one");
    const endpoint = overviewEndpoint({
        "local-one": {
            snapshot: () =>
                processEnvelope({
                    connectionState: "connected",
                    daemonState: "running",
                    lastSeq: 1,
                    name: asInstanceName("local-one"),
                    ready: true,
                    status: "ready",
                }),
            approvals: () => {
                throw new Error("approval store unavailable");
            },
            calls: () => {
                throw new Error("audit store unavailable");
            },
        },
    });
    const overview = await createOperationalOverviewRuntime({
        instanceCollector: collector(endpoint),
        instances: { list: () => [descriptor] },
        now: () => now,
        systemCollector: healthySystemCollector,
    }).read();

    assert.equal(overview.health, "attention");
    assert.equal(overview.instances.length, 1);
    assert.deepEqual(
        overview.alerts.map((alert) => alert.kind),
        ["overview.partial", "overview.partial"],
    );
});

function oauthApproval(
    approvalId: string,
    status: OAuthApprovalRequest["status"],
): OAuthApprovalRequest {
    return {
        approvalId,
        clientId: `client-${approvalId}`,
        clientName: approvalId,
        createdAt: "2026-07-30T23:00:00.000Z",
        expiresAt: "2026-08-01T23:00:00.000Z",
        kind: "authorization",
        redirectUris: ["https://example.invalid/callback"],
        requestedResources: [],
        requestedScopes: [],
        status,
    };
}
