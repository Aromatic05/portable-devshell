import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName, type ArtifactShareResult, type ArtifactTransferRecord } from "@portable-devshell/shared";
import {
    buildFocusGraphForState,
    CommandDispatcher,
    selectMainScreenModel,
    TuiAppStore,
    TuiControlSession,
    TuiFocusManager
} from "@portable-devshell/tui";

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

test("TUI startup pulls artifact shares and transfers from Control", async () => {
    const store = new TuiAppStore();
    const session = new TuiControlSession({
        client: {
            async getConfigView() { return {}; },
            async getMcpStatus() { return {}; },
            async listArtifactShares() { return [share]; },
            async listArtifactTransfers() { return [transfer]; },
            async listInstances() { return []; },
            async ping() { return { pong: true }; }
        } as never,
        store
    });

    await session.start();
    assert.deepEqual(store.getState().artifactShares, [share]);
    assert.deepEqual(store.getState().artifactTransfers, [transfer]);
    await session.stop();
});

test("artifact stream events upsert complete records without replacing shares from download audit events", () => {
    const store = new TuiAppStore();
    store.applyEvent({
        event: "artifact.shareCreated",
        payload: { at: "2026-07-13T00:00:00.000Z", data: share },
        seq: 1,
        target: { instance: asInstanceName("instance-a"), kind: "instance" },
        type: "event"
    });
    store.applyEvent({
        event: "artifact.shareDownloaded",
        payload: { at: "2026-07-13T00:00:01.000Z", data: { shareId: share.shareId } },
        seq: 2,
        target: { instance: asInstanceName("instance-a"), kind: "instance" },
        type: "event"
    });
    store.applyEvent({
        event: "artifact.transferProgress",
        payload: { at: "2026-07-13T00:00:02.000Z", data: transfer },
        seq: 3,
        target: { instance: asInstanceName("instance-a"), kind: "instance" },
        type: "event"
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
    const dispatcher = new CommandDispatcher({
        focusManager,
        mainViewportRows: () => 20,
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
