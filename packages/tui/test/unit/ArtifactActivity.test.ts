import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName, type ArtifactShareResult, type ArtifactTransferRecord, type JsonValue } from "@portable-devshell/shared";
import {
    buildFocusGraphForState,
    TuiCommandDispatcher,
    selectMainScreenModel,
    TuiAppStore,
    TuiControlSession,
    TuiFocusManager,
    tuiViewProjection
} from "@portable-devshell/tui/testing";

const share: ArtifactShareResult = {
    blake3: "a".repeat(64),
    bytes: 10,
    downloadName: "result.bin",
    expiresAtMs: Date.now() + 60_000,
    mediaType: "application/octet-stream",
    shareId: "share-12345678",
    source: { instance: "instance-a", path: "./result.bin", type: "file" },
    state: "active",
    url: "https://example.test/artifacts/share/token"
};

const transfer: ArtifactTransferRecord = {
    createdAt: "2026-07-13T00:00:00.000Z",
    source: { instance: "instance-a", path: "./result.bin", type: "file" },
    status: "transferring",
    target: { instance: "instance-b", path: "/srv/result.bin" },
    totalBytes: 10,
    transferId: "transfer-12345678",
    transferredBytes: 4,
    updatedAt: "2026-07-13T00:00:01.000Z"
};


function toJsonValue(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
}

test("TUI startup pulls artifact shares and transfers from Control", async () => {
    const store = new TuiAppStore();
    const session = new TuiControlSession({
        clients: {
            artifact: {
                async listShares() { return [share]; },
                async listTransfers() { return [transfer]; }
            },
            close() {},
            config: {
                async get() { return {}; }
            },
            instance: {
                async list() { return []; }
            },
            mcp: {
                async status() { return {}; }
            },
            overview: {
                async get() {
                    return {
                        activity: [],
                        alerts: [],
                        controller: { pid: 1, uptimeSeconds: 10 },
                        counts: {
                            activeTodos: 0,
                            failedCalls24h: 0,
                            instancesAttention: 0,
                            instancesCritical: 0,
                            instancesReady: 0,
                            instancesTotal: 0,
                            pendingApprovals: 0
                        },
                        generatedAt: "2026-07-31T00:00:00.000Z",
                        health: "healthy",
                        instances: [],
                        todos: []
                    };
                }
            },
            async reconnect() {},
            service: {
                async ping() { return { pong: true }; }
            }
        } as never,
        store
    });

    await session.start();
    assert.deepEqual(store.getState().artifactShares, [share]);
    assert.deepEqual(store.getState().artifactTransfers, [transfer]);
    await session.stop();
});

test("TUI clears an OAuth polling failure after the background refresh recovers", async () => {
    const store = new TuiAppStore();
    let approvalReads = 0;
    const session = new TuiControlSession({
        clients: {
            artifact: {
                async listShares() { return []; },
                async listTransfers() { return []; }
            },
            close() {},
            config: {
                async get() { return { mcp: { auth: { mode: "oauth2" } } }; }
            },
            instance: {
                async list() { return []; }
            },
            mcp: {
                async listApprovals() {
                    approvalReads += 1;
                    if (approvalReads === 2) throw new Error("OAuth service unavailable");
                    return [];
                },
                async status() { return {}; }
            },
            overview: {
                async get() {
                    return {
                        activity: [], alerts: [], controller: { pid: 1, uptimeSeconds: 10 },
                        counts: { activeTodos: 0, failedCalls24h: 0, instancesAttention: 0, instancesCritical: 0, instancesReady: 0, instancesTotal: 0, pendingApprovals: 0 },
                        generatedAt: "2026-07-31T00:00:00.000Z", health: "healthy" as const, instances: [], todos: []
                    };
                }
            },
            async reconnect() {},
            service: {
                async ping() { return { pong: true }; }
            }
        } as never,
        store
    });

    try {
        await session.start();
        await waitFor(() => store.getState().interaction.screenStatusByPage.oauth !== undefined);

        assert.equal(
            store.getState().interaction.screenStatusByPage.oauth,
            "OAuth refresh failed: OAuth service unavailable"
        );
        assert.equal(store.getState().connection.status, "connected");
        await waitFor(
            () => approvalReads >= 3 &&
                store.getState().interaction.screenStatusByPage.oauth === undefined
        );
    } finally {
        await session.stop();
    }
});

test("TUI discards a Todo refresh that completes after reconnect", async () => {
    let releaseTodo!: () => void;
    const pendingTodo = new Promise<{ todo: { items: []; revision: number; summary: { completed: number; total: number } } }>((resolve) => {
        releaseTodo = () => resolve({ todo: { items: [], revision: 2, summary: { completed: 0, total: 0 } } });
    });
    const session = new TuiControlSession({ clients: sessionClients({ todo: { get: async () => await pendingTodo } }) });

    await session.start();
    const staleRefresh = session.refreshTodo("alpha");
    await Promise.resolve();
    await session.reconnect();
    releaseTodo();
    await staleRefresh;

    assert.equal(session.store.getState().todoByInstance.alpha, undefined);
    await session.stop();
});

test("TUI does not subscribe after an obsolete instance refresh completes", async () => {
    let releaseSnapshot!: () => void;
    const pendingSnapshot = new Promise((resolve) => {
        releaseSnapshot = () => resolve({
            lastSeq: 2,
            snapshot: {
                connectionState: "connected", daemonState: "running", lastSeq: 2,
                name: asInstanceName("alpha"), ready: true, status: "ready"
            }
        });
    });
    const subscribe = async () => {
        throw new Error("stale refresh must not subscribe");
    };
    const session = new TuiControlSession({
        clients: sessionClients({ runtime: {
            readLogs: async () => [],
            snapshot: async () => await pendingSnapshot,
            subscribe
        } })
    });

    await session.start();
    const staleRefresh = session.refreshInstance("alpha");
    await Promise.resolve();
    await session.reconnect();
    releaseSnapshot();
    await staleRefresh;

    await session.stop();
});

test("TUI stops OAuth polling after a connection refresh fails", async () => {
    let approvalReads = 0;
    let failPing = false;
    const session = new TuiControlSession({
        clients: sessionClients({
            config: { async get() { return { mcp: { auth: { mode: "oauth2" } } }; } },
            mcp: {
                async listApprovals() { approvalReads += 1; return []; },
                async status() { return {}; }
            },
            service: { async ping() {
                if (failPing) throw new Error("control unavailable");
                return { pong: true };
            } }
        })
    });

    try {
        await session.start();
        failPing = true;
        await session.refresh();
        const readsAfterFailure = approvalReads;
        await new Promise((resolve) => setTimeout(resolve, 1_100));

        assert.equal(session.store.getState().connection.status, "error");
        assert.equal(approvalReads, readsAfterFailure);
    } finally {
        await session.stop();
    }
});

test("TUI ignores an old visible Overview failure after reconnect", async () => {
    let rejectOldOverview!: (error: Error) => void;
    const oldOverview = new Promise<never>((_resolve, reject) => {
        rejectOldOverview = reject;
    });
    let useOldOverview = false;
    const session = new TuiControlSession({
        clients: sessionClients({
            overview: { async get() {
                if (useOldOverview) return await oldOverview;
                return {
                    activity: [], alerts: [], controller: { pid: 1, uptimeSeconds: 1 },
                    counts: { activeTodos: 0, failedCalls24h: 0, instancesAttention: 0, instancesCritical: 0, instancesReady: 0, instancesTotal: 0, pendingApprovals: 0 },
                    generatedAt: "2026-07-31T00:00:00.000Z", health: "healthy" as const, instances: [], todos: []
                };
            } }
        }),
        overviewRefreshIntervalMs: 10
    });

    try {
        await session.start();
        session.store.setSelectedPage("overview");
        useOldOverview = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
        useOldOverview = false;
        await session.reconnect();
        rejectOldOverview(new Error("stale overview failure"));
        await new Promise((resolve) => setTimeout(resolve, 20));

        assert.equal(session.store.getState().interaction.screenStatusByPage.overview, undefined);
    } finally {
        await session.stop();
    }
});

test("artifact stream events upsert complete records without replacing shares from download audit events", () => {
    const store = new TuiAppStore();
    store.applyEvent({
        destination: asInstanceName("instance-a"),
        id: "artifact-share-created",
        name: "artifact.shareCreated",
        payload: { at: "2026-07-13T00:00:00.000Z", data: toJsonValue(share) },
        seq: 1
    });
    store.applyEvent({
        destination: asInstanceName("instance-a"),
        id: "artifact-share-downloaded",
        name: "artifact.shareDownloaded",
        payload: { at: "2026-07-13T00:00:01.000Z", data: { shareId: share.shareId } },
        seq: 2
    });
    store.applyEvent({
        destination: asInstanceName("instance-a"),
        id: "artifact-transfer-progress",
        name: "artifact.transferProgress",
        payload: { at: "2026-07-13T00:00:02.000Z", data: toJsonValue(transfer) },
        seq: 3
    });

    assert.deepEqual(store.getState().artifactShares, [share]);
    assert.deepEqual(store.getState().artifactTransfers, [transfer]);
});

test("instance box shows artifact activity and confirms revoke or cancel before dispatch", async () => {
    const store = seededStore();
    const revoked: string[] = [];
    const cancelled: string[] = [];
    const focusManager = new TuiFocusManager(store, {
        currentPage: () => store.getState().ui.selectedPage,
        graphFor: (page, mode) =>
            buildFocusGraphForState({
                ...store.getState(),
                interaction: { ...store.getState().interaction, focusScope: mode },
                ui: { ...store.getState().ui, selectedPage: page }
            }),
        mode: () => store.getState().interaction.focusScope
    });
    const dispatcher = new TuiCommandDispatcher({
        focusManager,
        mainViewportRows: () => 20,
        projection: tuiViewProjection,
        onApprovalDecision: async () => undefined,
        onArtifactCancelTransfer: async (transferId) => { cancelled.push(transferId); },
        onArtifactRevokeShare: async (shareId) => { revoked.push(shareId); },
        onAttachShell: async () => undefined,
        onInstanceAction: async () => undefined,
        onLogsReload: async () => undefined,
        onPageReload: async () => undefined,
        onQuit: async () => undefined,
        onRedraw: () => undefined,
        onToolCall: async () => true,
        store
    });

    const box = selectMainScreenModel(store.getState()).boxes.find((candidate) => candidate.id === "instance:instance-a")!;
    assert.match(box.collapsedLines[1]?.text ?? "", /artifacts shares=1 transfers=1 active=2/u);
    const revokeLine = box.expandedLines.find((line) => line.id?.includes("button:artifact-revoke:"));
    const cancelLine = box.expandedLines.find((line) => line.id?.includes("button:artifact-cancel:"));
    assert.ok(revokeLine?.id);
    assert.ok(cancelLine?.id);

    store.setFocusScope("boxDetail");
    store.setSelectedDetailLine(box.expandedKey, revokeLine.id);
    await dispatcher.dispatch({ type: "focus.activate" });
    assert.equal(store.getState().interaction.confirmDialog.open, true);
    assert.equal(store.getState().interaction.selectedConfirmButton, "cancel");
    assert.deepEqual(revoked, []);
    store.setConfirmFocus("confirm");
    await dispatcher.dispatch({ type: "confirm.accept" });
    assert.deepEqual(revoked, [share.shareId]);

    store.setFocusScope("boxDetail");
    store.setSelectedDetailLine(box.expandedKey, cancelLine.id);
    await dispatcher.dispatch({ type: "focus.activate" });
    assert.equal(store.getState().interaction.selectedConfirmButton, "cancel");
    store.setConfirmFocus("confirm");
    await dispatcher.dispatch({ type: "confirm.accept" });
    assert.deepEqual(cancelled, [transfer.transferId]);
});

function seededStore(): TuiAppStore {
    const store = new TuiAppStore();
    store.replaceInstances([
        {
            defaultWorkspace: "/workspace/a",
            enabled: true,
            mcpEnabled: true,
            name: "instance-a",
            provider: "local"
        }
    ]);
    store.replaceSnapshot({
        connectionState: "connected",
        daemonState: "running",
        lastSeq: 0,
        name: asInstanceName("instance-a"),
        ready: true,
        status: "ready"
    });
    store.replaceArtifactShares([share]);
    store.replaceArtifactTransfers([transfer]);
    store.setSelectedPage("instances");
    store.setSelectedInstance("instance-a");
    store.setMainFocusId("instance:instance-a");
    store.toggleExpanded("instances:instance-a:instance");
    return store;
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error("Timed out waiting for TUI state.");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function sessionClients(overrides: Record<string, unknown> = {}) {
    return {
        artifact: { async listShares() { return []; }, async listTransfers() { return []; } },
        close() {},
        config: { async get() { return {}; } },
        instance: { async list() { return []; } },
        mcp: { async status() { return {}; } },
        overview: { async get() {
            return {
                activity: [], alerts: [], controller: { pid: 1, uptimeSeconds: 1 },
                counts: { activeTodos: 0, failedCalls24h: 0, instancesAttention: 0, instancesCritical: 0, instancesReady: 0, instancesTotal: 0, pendingApprovals: 0 },
                generatedAt: "2026-07-31T00:00:00.000Z", health: "healthy" as const, instances: [], todos: []
            };
        } },
        async reconnect() {},
        service: { async ping() { return { pong: true }; } },
        ...overrides
    } as never;
}
