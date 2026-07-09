import assert from "node:assert/strict";
import test from "node:test";

import {
    buildFocusGraphForState,
    CommandDispatcher,
    KeyDispatcher,
    selectFooterText,
    selectHelpLines,
    selectMainScreenModel,
    selectSidebarModel,
    TuiAppStore,
    TuiFocusManager
} from "../../dist/index.js";

test("Prompt 3 urgent fix uses page + instance coordinates with two sidebar sections", async () => {
    const harness = createHarness();

    const sidebar = selectSidebarModel(harness.store.getState());
    assert.deepEqual(
        sidebar.pages.map((item) => item.label),
        ["instances", "config", "connector", "audit", "logs", "help"]
    );
    assert.deepEqual(
        sidebar.instances.map((item) => item.label),
        ["alpha", "beta"]
    );
    assert.equal(JSON.stringify(sidebar).includes("Pages"), false);
    assert.equal(JSON.stringify(sidebar).includes("Instance"), false);

    assert.equal(harness.store.getState().ui.selectedPage, "instances");
    assert.equal(harness.store.getState().ui.selectedInstance, "alpha");
    await harness.press("", { tab: true });
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");
    assert.deepEqual(
        selectMainScreenModel(harness.store.getState()).boxes.map((box) => box.title),
        ["alpha", "beta"]
    );
    await harness.press("[", { ctrl: true });
    assert.equal(harness.store.getState().interaction.focusScope, "sidebarPages");

    await harness.press("", { downArrow: true });
    assert.equal(harness.store.getState().ui.selectedPage, "instances");
    assert.equal(harness.store.getState().interaction.sidebarCursor?.kind, "page");
    assert.equal(harness.store.getState().interaction.sidebarCursor?.id, "config");

    await harness.press("", { return: true });
    assert.equal(harness.store.getState().ui.selectedPage, "config");

    for (let index = 0; index < 6; index += 1) {
        await harness.press("", { downArrow: true });
    }
    assert.equal(harness.store.getState().interaction.sidebarCursor?.kind, "instance");
    assert.equal(harness.store.getState().interaction.sidebarCursor?.id, "beta");
    assert.equal(harness.store.getState().ui.selectedInstance, "alpha");

    await harness.press("", { return: true });
    assert.equal(harness.store.getState().ui.selectedInstance, "beta");
});

test("Prompt 3 urgent fix expands stable bordered boxes and preserves state through stream updates", async () => {
    const harness = createHarness();

    await harness.press("", { tab: true });

    const firstBoxId = harness.store.getState().ui.mainFocusId;
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");
    assert.equal(typeof firstBoxId, "string");
    assert.match(selectFooterText(harness.store.getState()), /space/u);

    await harness.press(" ");
    const expandedKey = `instances:alpha:${firstBoxId}`;
    assert.equal(harness.store.getState().ui.expandedBoxes[expandedKey], true);

    harness.store.applyEvent({
        event: "log.appended",
        payload: {
            at: "2026-07-09T00:00:21.000Z",
            data: {
                bytes: 4,
                stream: "stdout",
                tail: "tail"
            }
        },
        seq: 21,
        target: {
            instance: "alpha",
            kind: "instance"
        },
        type: "event"
    } as never);

    assert.equal(harness.store.getState().ui.selectedPage, "instances");
    assert.equal(harness.store.getState().ui.selectedInstance, "alpha");
    assert.equal(harness.store.getState().ui.expandedBoxes[expandedKey], true);

    await harness.press("", { return: true });
    assert.equal(harness.store.getState().interaction.focusScope, "boxDetail");
    await harness.press("", { escape: true });
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");
    await harness.press("[", { ctrl: true });
    assert.equal(harness.store.getState().interaction.focusScope, "sidebarPages");
});

test("Prompt 3 urgent fix keeps connector and logs pages read-only and instance-scoped", async () => {
    const harness = createHarness();

    await harness.press("3");
    const connector = selectMainScreenModel(harness.store.getState());
    assert.deepEqual(
        connector.boxes.map((box) => box.title),
        ["MCP Runtime Config", "Endpoint Preview", "Auth Config", "Public Availability Reason"]
    );
    assert.equal(
        connector.boxes.some((box) => box.expandedLines.some((line) => line.text.includes("Runtime readiness: not available in current control API"))),
        true
    );

    await harness.press("5");
    assert.equal(harness.logsReloadCount(), 1);
    const logs = selectMainScreenModel(harness.store.getState());
    assert.equal(logs.activePage.page, "logs");
    assert.equal(logs.activePage.instance, "alpha");
    assert.equal(logs.boxes[0]?.collapsedLines[0]?.text, "source=instance.readLogs+log.appended  entries=20");

    await harness.press("6");
    assert.equal(selectHelpLines(harness.store.getState()).some((line) => line.includes("Read-only cockpit")), true);
});

test("Main viewport scrolling uses one page-instance offset instead of per-box offsets", async () => {
    const harness = createHarness();

    await harness.press("5");
    await harness.press("", { tab: true });
    await harness.press(" ");
    await harness.press("", { pageDown: true });

    assert.equal(harness.store.getState().ui.scrollOffsets["logs:alpha:logs"], undefined);
    assert.equal((harness.store.getState().ui.scrollOffsets["logs:alpha:main"] ?? 0) > 0, true);
    assert.equal(selectMainScreenModel(harness.store.getState()).boxes[0]?.expandedLines.length, 20);
});

test("Moving focus down advances the shared main viewport to keep the focused box visible", async () => {
    const harness = createHarness();

    await harness.press("", { tab: true });
    await harness.press(" ");
    await harness.press("", { downArrow: true });

    assert.equal(harness.store.getState().ui.mainFocusId, "instance-beta");
    assert.equal((harness.store.getState().ui.scrollOffsets["instances:alpha:main"] ?? 0) > 0, true);
});

function createHarness() {
    const store = new TuiAppStore();
    seedPrompt3State(store);
    let logsReloadRequests = 0;
    const focusManager = new TuiFocusManager(store, {
        currentPage: () => store.getState().ui.selectedPage,
        graphFor: (page, mode) =>
            buildFocusGraphForState({
                ...store.getState(),
                interaction: {
                    ...store.getState().interaction,
                    focusScope: mode
                },
                ui: {
                    ...store.getState().ui,
                    selectedPage: page
                }
            }),
        mode: () => store.getState().interaction.focusScope
    });
    const commandDispatcher = new CommandDispatcher({
        focusManager,
        mainViewportRows: () => 12,
        onLogsReload: async () => {
            logsReloadRequests += 1;
        },
        onQuit: async () => undefined,
        onRedraw: () => undefined,
        store
    });
    const keyDispatcher = new KeyDispatcher();

    focusManager.syncPanel(store.getState().ui.selectedPage, store.getState().interaction.focusScope);

    return {
        async press(input: string, key: Record<string, boolean> = {}) {
            await commandDispatcher.dispatchMany(keyDispatcher.dispatch(store.getState().interaction.focusScope, { input, key }));
        },
        logsReloadCount() {
            return logsReloadRequests;
        },
        store
    };
}

function seedPrompt3State(store: TuiAppStore) {
    store.replaceInstances([
        {
            defaultWorkspace: "/workspace/alpha",
            enabled: true,
            mcpEnabled: true,
            mcpPath: "/alpha/mcp",
            name: "alpha",
            provider: "local"
        },
        {
            defaultWorkspace: "/workspace/beta",
            enabled: true,
            mcpEnabled: false,
            mcpPath: "/beta/mcp",
            name: "beta",
            provider: "ssh"
        }
    ]);
    store.setConfigView({
        instances: [
            {
                enabled: true,
                mcp: { enabled: true, path: "/alpha/mcp" },
                name: "alpha",
                provider: "local",
                workspace: "/workspace/alpha"
            },
            {
                enabled: true,
                mcp: { enabled: false, path: "/beta/mcp" },
                name: "beta",
                provider: "ssh",
                workspace: "/workspace/beta"
            }
        ],
        mcp: {
            auth: { mode: "none" },
            enabled: true,
            listenHost: "127.0.0.1",
            listenPort: 3210
        }
    });
    store.replaceSnapshot({
        connectionState: "connected",
        daemonState: "running",
        lastSeq: 20,
        name: "alpha",
        ready: true,
        status: "ready"
    } as never);
    store.replaceSnapshot({
        connectionState: "connected",
        daemonState: "stopped",
        lastSeq: 12,
        name: "beta",
        ready: false,
        status: "stopped"
    } as never);
    store.replaceToolCalls("alpha", [
        {
            callId: "call-1",
            completedAt: "2026-07-09T00:00:01.000Z",
            inputSummary: "{\"cmd\":\"pwd\"}",
            instance: "alpha" as never,
            source: "tui",
            startedAt: "2026-07-09T00:00:00.000Z",
            status: "completed",
            timedOut: false,
            toolName: "bash_run"
        }
    ]);
    store.replaceApprovals("alpha", [
        {
            approvalId: "approval-1",
            callId: "call-1",
            createdAt: "2026-07-09T00:00:00.000Z",
            expiresAt: "2026-07-09T00:10:00.000Z",
            inputSummary: "{\"cmd\":\"rm\"}",
            instance: "alpha" as never,
            reason: "needs review",
            riskLevel: "high",
            source: "tui",
            status: "pending",
            toolName: "bash_run"
        }
    ]);
    store.replaceLogs("alpha", [
        ...Array.from({ length: 20 }, (_, index) => ({
            instance: "alpha",
            message: `alpha line ${index + 1}`,
            receivedAt: `2026-07-09T00:00:${String(index).padStart(2, "0")}.000Z`,
            seq: index + 1,
            stream: "stdout" as const
        }))
    ]);
    store.replaceLogs("beta", [
        {
            instance: "beta",
            message: "beta line 1",
            receivedAt: "2026-07-09T00:01:00.000Z",
            seq: 1,
            stream: "stderr" as const
        }
    ]);
}
