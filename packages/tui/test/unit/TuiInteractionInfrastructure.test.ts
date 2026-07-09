import assert from "node:assert/strict";
import test from "node:test";

import {
    buildFocusGraphForState,
    CommandDispatcher,
    KeyDispatcher,
    selectFooterText,
    selectHelpLines,
    TuiAppStore,
    TuiFocusManager
} from "../../dist/index.js";

test("Prompt 3 panel routing and instances detail stay read-only", async () => {
    const harness = createHarness();

    await harness.press("1");
    assert.equal(harness.store.getState().activePanel, "instances");
    assert.deepEqual(harness.store.getState().interaction.currentFocus, { id: "instances.summary", kind: "card" });

    await harness.press("", { downArrow: true });
    assert.deepEqual(harness.store.getState().interaction.currentFocus, { id: "instances.row.0", kind: "listItem" });

    await harness.press("", { return: true });
    assert.equal(harness.store.getState().interaction.screenStatusByPanel.instances, "Opened selected instance detail without starting worker.");
    assert.equal(harness.store.getState().interaction.screenToggleByPanel.instances, true);

    await harness.press(" ");
    assert.equal(harness.store.getState().interaction.screenToggleByPanel.instances, false);

    await harness.press("2");
    assert.equal(harness.store.getState().activePanel, "connector");

    await harness.press("]");
    assert.equal(harness.store.getState().activePanel, "audit");

    await harness.press("[");
    assert.equal(harness.store.getState().activePanel, "connector");
});

test("Prompt 3 action menu is read-only placeholder and help/footer reflect current mode", async () => {
    const harness = createHarness();

    assert.match(selectFooterText(harness.store.getState()), /1-6/u);

    await harness.press("a");
    assert.equal(harness.store.getState().interaction.mode, "actionMenu");
    assert.equal(harness.store.getState().interaction.actionMenu.open, true);
    assert.deepEqual(harness.store.getState().interaction.currentFocus, { id: "instances.readonly", kind: "action" });

    await harness.press("", { return: true });
    assert.equal(harness.store.getState().interaction.mode, "normal");
    assert.equal(harness.store.getState().interaction.screenStatusByPanel.instances, "Read-only action menu placeholder.");

    await harness.press("6");
    assert.equal(harness.store.getState().activePanel, "help");
    assert.equal(selectHelpLines(harness.store.getState()).some((line) => line.includes("Read-only cockpit")), true);
});

test("Prompt 3 search stays local and approvals cards only expand locally", async () => {
    const harness = createHarness();

    await harness.press("5");
    assert.equal(harness.store.getState().activePanel, "approvals");

    await harness.press("/");
    assert.equal(harness.store.getState().interaction.mode, "search");
    await harness.press("a");
    await harness.press("", { return: true });
    assert.equal(harness.store.getState().interaction.search.query, "a");
    assert.equal(harness.store.getState().interaction.mode, "normal");

    await harness.press("", { downArrow: true });
    assert.deepEqual(harness.store.getState().interaction.currentFocus, { id: "approvals.row.0", kind: "listItem" });

    await harness.press(" ");
    assert.equal(harness.store.getState().interaction.expandedByKey["approval.alpha.approval-1"], true);
    assert.equal(harness.store.getState().interaction.screenStatusByPanel.approvals, "Expanded approvals card.");
});

test("Prompt 3 logs page reloads, scrolls, toggles follow, and clear only resets UI buffer", async () => {
    const harness = createHarness();

    await harness.press("4");
    assert.equal(harness.store.getState().activePanel, "logs");
    assert.equal(harness.logsReloadCount(), 1);
    assert.equal(harness.store.getState().interaction.screenStatusByPanel.logs, "Logs reloaded from instance.readLogs.");

    await harness.press("", { upArrow: true });
    assert.equal(harness.store.getState().interaction.logsViewport.follow, false);

    await harness.press("f");
    assert.equal(harness.store.getState().interaction.logsViewport.follow, true);

    await harness.press("r");
    assert.equal(harness.logsReloadCount(), 2);

    await harness.press("c");
    assert.deepEqual(harness.store.getState().logsByInstance, {});
    assert.equal(harness.store.getState().interaction.screenStatusByPanel.logs, "Cleared local log buffer only.");
});

function createHarness() {
    const store = new TuiAppStore();
    seedPrompt3State(store);
    let quitRequests = 0;
    let redrawRequests = 0;
    let logsReloadRequests = 0;
    const focusManager = new TuiFocusManager(store, {
        currentPanel: () => store.getState().activePanel,
        graphFor: (panel, mode) =>
            buildFocusGraphForState({
                ...store.getState(),
                activePanel: panel,
                interaction: {
                    ...store.getState().interaction,
                    mode
                }
            }),
        mode: () => store.getState().interaction.mode
    });
    const commandDispatcher = new CommandDispatcher({
        focusManager,
        onLogsReload: async () => {
            logsReloadRequests += 1;
        },
        onQuit: async () => {
            quitRequests += 1;
        },
        onRedraw: () => {
            redrawRequests += 1;
        },
        store
    });
    const keyDispatcher = new KeyDispatcher();

    focusManager.syncPanel(store.getState().activePanel, store.getState().interaction.mode);

    return {
        async press(input: string, key: Record<string, boolean> = {}) {
            await commandDispatcher.dispatchMany(keyDispatcher.dispatch(store.getState().interaction.mode, { input, key }));
        },
        logsReloadCount() {
            return logsReloadRequests;
        },
        quitCount() {
            return quitRequests;
        },
        redrawCount() {
            return redrawRequests;
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
        lastSeq: 3,
        name: "alpha",
        ready: true,
        status: "ready"
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
            message: `line ${index + 1}`,
            receivedAt: `2026-07-09T00:00:${String(index).padStart(2, "0")}.000Z`,
            seq: index + 1,
            stream: "stdout" as const
        }))
    ]);
}
