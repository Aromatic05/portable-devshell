import assert from "node:assert/strict";
import test from "node:test";

import { renderExpandableBoxLines } from "../../dist/component/ExpandableBox.js";
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

test("Prompt 3 urgent fix uses page + instance coordinates with a two-stage Tab cycle", async () => {
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
        ["Create Instance", "alpha", "beta"]
    );
    await harness.press("[", { ctrl: true });
    assert.equal(harness.store.getState().interaction.focusScope, "sidebarPages");
    await harness.press("", { tab: true });
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");
    await harness.press("", { shift: true, tab: true });
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

    await harness.press("", { tab: true });
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");
    await harness.press("", { shift: true, tab: true });
    assert.equal(harness.store.getState().interaction.focusScope, "sidebarInstances");

    await harness.press("", { return: true });
    assert.equal(harness.store.getState().ui.selectedInstance, "beta");
});

test("Prompt 3 detail line focus preserves state through stream updates", async () => {
    const harness = createHarness();

    await harness.press("", { tab: true });
    await harness.press("", { downArrow: true });

    const firstBoxId = harness.store.getState().ui.mainFocusId;
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");
    assert.equal(typeof firstBoxId, "string");
    assert.match(selectFooterText(harness.store.getState()), /space/u);

    const expandedKey = "instances:alpha:instance";
    await harness.press("", { return: true });
    assert.equal(harness.store.getState().ui.expandedBoxes[expandedKey], true);
    assert.equal(harness.store.getState().interaction.focusScope, "boxDetail");

    const initialBox = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === firstBoxId);
    assert.equal(harness.store.getState().interaction.selectedDetailLineIds[expandedKey], initialBox?.expandedLines[0]?.id);
    await harness.press("", { downArrow: true });
    const selectedLineId = harness.store.getState().interaction.selectedDetailLineIds[expandedKey];
    assert.equal(selectedLineId, initialBox?.expandedLines[1]?.id);
    const focusedBox = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === firstBoxId);
    const selectedRenderLine = renderExpandableBoxLines(focusedBox!, 48).find((line) => line.key === `${firstBoxId}-${selectedLineId}`);
    assert.equal(selectedRenderLine?.backgroundColor, "cyan");

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
    assert.equal(harness.store.getState().interaction.selectedDetailLineIds[expandedKey], selectedLineId);

    await harness.press("", { escape: true });
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");
    await harness.press("[", { ctrl: true });
    assert.equal(harness.store.getState().interaction.focusScope, "sidebarPages");
});

test("main box focus activates the main panel from the sidebar", () => {
    const harness = createHarness();

    const moved = harness.focusManager.setFocus({ id: "instance:alpha", kind: "box" });

    assert.equal(moved, true);
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");
    assert.equal(harness.store.getState().ui.mainFocusId, "instance:alpha");
});

test("Prompt 3 detail line selection clamps to a valid line after data replacement", async () => {
    const harness = createHarness();

    await harness.press("5");
    await harness.press("", { tab: true });
    await harness.press("", { return: true });
    await harness.press("", { downArrow: true });

    const key = "logs:alpha:logs";
    assert.equal(harness.store.getState().interaction.selectedDetailLineIds[key], "logs:stdout:2");
    harness.store.replaceLogs("alpha", []);

    const logsBox = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "logs");
    assert.equal(logsBox?.selectedDetailLineId, logsBox?.expandedLines[0]?.id);
    assert.equal(logsBox?.selectedDetailLineId, "logs:No");
});

test("Prompt 4 keeps connector and logs instance-scoped until an explicit action", async () => {
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
    assert.equal(selectHelpLines(harness.store.getState()).some((line) => line.includes("Read-only until an explicit instance action")), true);
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
    await harness.press("", { downArrow: true });
    await harness.press(" ");
    await harness.press("", { downArrow: true });

    assert.equal(harness.store.getState().ui.mainFocusId, "instance:beta");
    assert.equal((harness.store.getState().ui.scrollOffsets["instances:collection:main"] ?? 0) > 0, true);
});

test("instance actions require a focused entry and Stop defaults to Cancel", async () => {
    const harness = createHarness();

    await harness.press("", { tab: true });
    await harness.press("", { downArrow: true });
    await harness.press("a");
    assert.equal(harness.store.getState().interaction.focusScope, "actionMenu");
    assert.equal(harness.store.getState().interaction.actionMenu.items[0]?.label, "Attach Shell");
    await harness.press("", { downArrow: true });
    await harness.press("", { downArrow: true });
    await harness.press("", { return: true });

    assert.equal(harness.store.getState().interaction.focusScope, "confirm");
    assert.equal(harness.store.getState().interaction.selectedConfirmButton, "cancel");
    await harness.press("", { return: true });
    assert.deepEqual(harness.instanceActions(), []);
    assert.equal(harness.store.getState().ui.selectedInstance, "alpha");
});

test("Prompt 4 approval action uses the selected detail line without deciding", async () => {
    const harness = createHarness();

    await harness.press("4");
    await harness.press("", { tab: true });
    await harness.press("", { downArrow: true });
    await harness.press("", { return: true });
    assert.equal(harness.store.getState().interaction.focusScope, "boxDetail");
    for (let index = 0; index < 5; index += 1) {
        await harness.press("", { downArrow: true });
    }
    assert.equal(harness.store.getState().interaction.selectedDetailLineIds["audit:alpha:approval-approval-1"], "approval-approval-1:approval.action:approval-1");
    await harness.press("", { return: true });

    assert.equal(harness.store.getState().interaction.focusScope, "actionMenu");
    assert.deepEqual(
        harness.store.getState().interaction.actionMenu.items.map((item) => item.label),
        ["Approve", "Deny", "Cancel"]
    );
    assert.equal(harness.store.getState().interaction.selectedActionId, "approval.approve");
    assert.deepEqual(harness.approvalDecisions(), []);
});

test("Prompt 4 tool form is bound to the selected audit detail line", async () => {
    const harness = createHarness();

    await harness.press("4");
    await harness.press("", { tab: true });
    await harness.press("", { return: true });
    for (let index = 0; index < 7; index += 1) {
        await harness.press("", { downArrow: true });
    }
    await harness.press("", { return: true });

    assert.equal(harness.store.getState().interaction.focusScope, "toolForm");
    assert.equal(harness.store.getState().interaction.toolForm?.instance, "alpha");
    assert.equal(harness.store.getState().interaction.toolForm?.toolName, "bash_run");
});

test("Prompt 4 command failure keeps the selected detail target", async () => {
    const harness = createHarness({ onToolCall: async () => false });

    await harness.press("4");
    await harness.press("", { tab: true });
    await harness.press("", { return: true });
    for (let index = 0; index < 7; index += 1) {
        await harness.press("", { downArrow: true });
    }
    await harness.press("", { return: true });
    await harness.press("", { return: true });

    assert.equal(harness.store.getState().ui.selectedPage, "audit");
    assert.equal(harness.store.getState().ui.selectedInstance, "alpha");
    assert.equal(harness.store.getState().interaction.focusScope, "toolForm");
    assert.equal(harness.store.getState().interaction.toolForm?.toolName, "bash_run");
});

test("Attach Shell uses the focused collection entry and confirms before running", async () => {
    const harness = createHarness();

    await harness.press("", { tab: true });
    await harness.press("a");
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");

    await harness.press("", { downArrow: true });
    await harness.press("a");
    assert.equal(harness.store.getState().interaction.actionMenu.items[0]?.label, "Attach Shell");
    await harness.press("", { return: true });

    assert.equal(harness.store.getState().interaction.confirmDialog.title, "UNMANAGED SHELL");
    assert.equal(harness.store.getState().interaction.confirmDialog.body, "This shell is not audited and is not controlled by devshell.");
    assert.deepEqual(harness.shellAttaches(), []);
    await harness.press("", { rightArrow: true });
    await harness.press("", { return: true });

    assert.deepEqual(harness.shellAttaches(), ["alpha"]);
    assert.deepEqual(harness.instanceActions(), []);
    assert.equal(harness.store.getState().toolCallsByInstance.alpha?.length, 1);
});

test("non-collection actions attach only the selected sidebar entry", async () => {
    const harness = createHarness();

    await harness.press("3");
    await harness.press("a");

    assert.equal(harness.store.getState().interaction.actionMenu.items[0]?.label, "Attach Shell to alpha");
});

function createHarness(options: {
    onAttachShell?: (instance: string) => Promise<void>;
    onToolCall?: (instance: string, toolName: string, input: string) => Promise<boolean>;
} = {}) {
    const store = new TuiAppStore();
    seedPrompt3State(store);
    const approvalDecisions: Array<{ approvalId: string; decision: string; instance: string }> = [];
    const instanceActions: Array<{ action: string; instance: string }> = [];
    const shellAttaches: string[] = [];
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
        onApprovalDecision: async (instance, approvalId, decision) => {
            approvalDecisions.push({ approvalId, decision, instance });
        },
        onInstanceAction: async (action, instance) => {
            instanceActions.push({ action, instance });
        },
        onAttachShell: options.onAttachShell ?? (async (instance) => {
            shellAttaches.push(instance);
        }),
        onLogsReload: async () => {
            logsReloadRequests += 1;
        },
        onQuit: async () => undefined,
        onRedraw: () => undefined,
        onToolCall: options.onToolCall ?? (async () => true),
        store
    });
    const keyDispatcher = new KeyDispatcher();

    focusManager.syncPanel(store.getState().ui.selectedPage, store.getState().interaction.focusScope);

    return {
        async press(input: string, key: Record<string, boolean> = {}) {
            await commandDispatcher.dispatchMany(keyDispatcher.dispatch(store.getState().interaction.focusScope, { input, key }));
        },
        approvalDecisions() {
            return approvalDecisions;
        },
        focusManager,
        instanceActions() {
            return instanceActions;
        },
        logsReloadCount() {
            return logsReloadRequests;
        },
        shellAttaches() {
            return shellAttaches;
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
