import assert from "node:assert/strict";
import test from "node:test";

import { renderExpandableBoxLines } from "../../dist/component/ExpandableBox.js";
import {
    buildFocusGraphForState,
    buildTuiHitRegions,
    CommandDispatcher,
    KeyDispatcher,
    selectFooterText,
    selectHelpLines,
    selectMainScreenModel,
    selectSidebarModel,
    hitTargetAt,
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

test("mouse hit regions follow the rendered sidebar, boxes, and overlays", () => {
    const harness = createHarness();
    const viewport = { columns: 120, rows: 40 };
    const initialRegions = buildTuiHitRegions(harness.store.getState(), viewport);
    const pageRegion = initialRegions.find((region) => region.target.kind === "page" && region.target.id === "config")!;
    const instanceRegion = initialRegions.find((region) => region.target.kind === "instance" && region.target.id === "alpha")!;
    const boxRegion = initialRegions.find((region) => region.target.kind === "boxTitle" && region.target.boxId === "create-instance")!;

    assert.deepEqual(hitTargetAt(initialRegions, pageRegion.x, pageRegion.y), pageRegion.target);
    assert.deepEqual(hitTargetAt(initialRegions, instanceRegion.x, instanceRegion.y), instanceRegion.target);
    assert.deepEqual(hitTargetAt(initialRegions, boxRegion.x, boxRegion.y), boxRegion.target);

    harness.store.setActionMenu("Actions", [{ id: "attach", intent: { type: "actionMenu.open" }, label: "Attach Shell" }], 0);
    const actionRegions = buildTuiHitRegions(harness.store.getState(), viewport);
    const actionRegion = actionRegions.find((region) => region.target.kind === "action")!;
    assert.deepEqual(hitTargetAt(actionRegions, actionRegion.x, actionRegion.y), actionRegion.target);

    harness.store.setPanelError("instances:alpha", { code: "control.failed", message: "rendered error" });
    const erroredRegions = buildTuiHitRegions(harness.store.getState(), viewport);
    const shiftedBoxRegion = erroredRegions.find((region) => region.target.kind === "boxTitle" && region.target.boxId === "create-instance")!;
    assert.equal(shiftedBoxRegion.y, boxRegion.y + 3);
});

test("space expands a box without blocking main box navigation", async () => {
    const harness = createHarness();

    await harness.press("", { tab: true });
    await harness.press("", { downArrow: true });

    const firstBoxId = harness.store.getState().ui.mainFocusId;
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");
    assert.equal(typeof firstBoxId, "string");
    assert.match(selectFooterText(harness.store.getState()), /space/u);

    const expandedKey = "instances:alpha:instance";
    await harness.press("", { return: true });
    assert.equal(harness.store.getState().ui.expandedBoxes[expandedKey], undefined);
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");

    await harness.press(" ");
    assert.equal(harness.store.getState().ui.expandedBoxes[expandedKey], true);
    const expandedBox = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === firstBoxId)!;
    const expandedRenderLines = renderExpandableBoxLines(expandedBox, 48);
    assert.equal(expandedRenderLines.length, expandedBox.expandedLines.length + 2);
    assert.equal(expandedRenderLines.some((line) => line.key === `${firstBoxId}-top`), true);
    await harness.press("", { downArrow: true });
    assert.equal(typeof harness.store.getState().interaction.selectedDetailLineIds[expandedKey], "string");
    await harness.press(" ");
    assert.equal(harness.store.getState().ui.expandedBoxes[expandedKey], false);
    assert.equal(harness.store.getState().interaction.selectedDetailLineIds[expandedKey], undefined);
    await harness.press(" ");
    const expandedLineCount = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === firstBoxId)!.expandedLines.length;
    for (let index = 0; index < expandedLineCount; index += 1) {
        await harness.press("", { downArrow: true });
    }
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");
    assert.equal(harness.store.getState().ui.mainFocusId, "instance:beta");
});

test("main box focus activates the main panel from the sidebar", () => {
    const harness = createHarness();

    const moved = harness.focusManager.setFocus({ id: "instance:alpha", kind: "box" });

    assert.equal(moved, true);
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");
    assert.equal(harness.store.getState().ui.mainFocusId, "instance:alpha");
});

test("Create flow uses a wizard with focusable fields and command buttons", async () => {
    const harness = createHarness();

    await openCreateWizard(harness);

    assert.equal(harness.store.getState().interaction.focusScope, "wizard");
    assert.equal(harness.store.getState().ui.mainFocusId, "create-wizard");
    const wizard = selectMainScreenModel(harness.store.getState()).boxes[0];
    assert.equal(wizard?.title, "Create");
    assert.equal(harness.store.getState().interaction.selectedDetailLineIds["instances:all:create-wizard"], wizard?.expandedLines[2]?.id);
    await harness.press("", { upArrow: true });
    assert.equal(harness.store.getState().interaction.selectedDetailLineIds["instances:all:create-wizard"], wizard?.expandedLines[1]?.id);
    await harness.press("", { upArrow: true });
    assert.equal(harness.store.getState().interaction.selectedDetailLineIds["instances:all:create-wizard"], wizard?.expandedLines[0]?.id);
    assert.equal(wizard?.expandedLines.some((line) => line.id?.includes(":field:name")), true);
    assert.equal(wizard?.expandedLines.some((line) => line.id?.includes(":button:validate")), true);
    assert.equal(wizard?.expandedLines.some((line) => line.id?.includes(":button:create")), true);
    assert.equal(wizard?.expandedLines.some((line) => line.id?.includes(":button:cancel")), true);
});

test("wizard validation keeps the draft and reports the control error", async () => {
    const harness = createHarness({
        onValidateInstanceCreateDraft: async () => {
            throw new Error("name is required");
        }
    });

    await openCreateWizard(harness);
    await harness.dispatch({ type: "editor.validate" });

    assert.equal(harness.store.getState().interaction.focusScope, "wizard");
    assert.equal(harness.store.getState().interaction.editor?.error, "name is required");
    assert.notEqual(harness.store.getState().ui.formDrafts.create, undefined);
});

test("editing a field supports backspace, cursor movement, and inline cursor rendering", async () => {
    const harness = createHarness();

    await openCreateWizard(harness);
    await harness.press("", { return: true });
    await harness.press("a");
    await harness.press("b");
    await harness.press("c");
    await harness.press("d");
    await harness.press("", { leftArrow: true });
    await harness.press("", { leftArrow: true });
    await harness.press("", { backspace: true });
    await harness.press("", { delete: true });
    await harness.press("", { leftArrow: true });
    await harness.press("z");

    assert.equal((harness.store.getState().ui.formDrafts.create as { name?: unknown }).name, "zcd");
    const wizard = selectMainScreenModel(harness.store.getState()).boxes[0];
    assert.equal(wizard?.expandedLines.some((line) => line.text.includes("█")), true);
});

test("wizard normalizes friendly container mode labels before control validation", async () => {
    let validatedMode: unknown;
    const harness = createHarness({
        onValidateInstanceCreateDraft: async (draft) => {
            validatedMode = (draft as { container?: { mode?: unknown } }).container?.mode;
            return {};
        }
    });

    await openCreateWizard(harness);
    harness.store.setFormDraft("create", { container: { mode: "Existing stopped container" }, name: "alpha", provider: "docker" });
    await harness.dispatch({ type: "editor.validate" });

    assert.equal(validatedMode, "existingStoppedContainer");
    assert.equal((harness.store.getState().ui.formDrafts.create as { container?: { mode?: unknown } }).container?.mode, "existingStoppedContainer");
});

test("config validation errors render in the active field box", async () => {
    const harness = createHarness({
        onValidateConfigDraft: async () => {
            throw new Error("workspace must be an absolute path");
        }
    });

    await harness.press("2");
    await harness.press("", { tab: true });
    await harness.press(" ");
    await harness.press("", { downArrow: true });
    await harness.press("", { return: true });
    await harness.press("s", { ctrl: true });

    const provider = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "provider");
    assert.equal(provider?.expandedLines.some((line) => line.text === "error: workspace must be an absolute path"), true);
});

test("config choices use angle selectors and switch with arrow keys", async () => {
    const harness = createHarness();

    await harness.press("2");
    await harness.press("", { tab: true });
    await harness.press(" ");
    await harness.press("", { downArrow: true });
    await harness.press("", { return: true });
    harness.store.setFormDraft("config:alpha", {
        approvalPolicy: { mode: "ask" },
        enabled: true,
        mcp: { enabled: true, path: "/alpha/mcp" },
        name: "alpha",
        provider: "local",
        security: { mode: "disabled" },
        workspace: "/workspace/alpha"
    });

    const boxes = selectMainScreenModel(harness.store.getState()).boxes;
    assert.equal(boxes.find((box) => box.id === "provider")?.expandedLines[0]?.text.endsWith("<local>"), true);
    assert.equal(boxes.find((box) => box.id === "security")?.expandedLines[0]?.text.endsWith("<disabled>"), true);
    assert.equal(boxes.find((box) => box.id === "approval-policy")?.expandedLines[0]?.text.endsWith("<ask>"), true);

    await harness.press("", { rightArrow: true });
    assert.equal((harness.store.getState().ui.formDrafts["config:alpha"] as { provider?: unknown }).provider, "ssh");
    await harness.press("", { leftArrow: true });
    assert.equal((harness.store.getState().ui.formDrafts["config:alpha"] as { provider?: unknown }).provider, "local");
});

test("connector discard confirms and clears its per-instance MCP draft", async () => {
    const harness = createHarness();

    await harness.press("3");
    await harness.press("", { tab: true });
    await harness.press(" ");
    await harness.press("", { downArrow: true });
    await harness.press("", { return: true });
    await harness.press("", { return: true });

    assert.equal(harness.store.getState().ui.dirtyForms["config:alpha"], true);
    await harness.dispatch({ type: "editor.discard" });
    assert.equal(harness.store.getState().interaction.confirmDialog.open, true);
    assert.equal(harness.store.getState().interaction.selectedConfirmButton, "cancel");
    await harness.press("", { rightArrow: true });
    await harness.press("", { return: true });

    assert.equal(harness.store.getState().interaction.editor, undefined);
    assert.equal(harness.store.getState().ui.formDrafts["config:alpha"], undefined);
});

test("instances collection does not append a start command box", () => {
    const harness = createHarness();
    harness.store.upsertCommand({
        commandId: "start-alpha",
        sourcePanel: "instances",
        startedAt: "2026-07-10T00:00:00.000Z",
        status: "succeeded",
        targetInstance: "alpha",
        title: "Start Worker: alpha"
    });

    assert.deepEqual(selectMainScreenModel(harness.store.getState()).boxes.map((box) => box.id), ["create-instance", "instance:alpha", "instance:beta"]);
});

test("expanded entries retain Attach Shell alongside the configuration actions", async () => {
    const harness = createHarness();

    await harness.press("", { tab: true });
    await harness.press("", { downArrow: true });
    await harness.press(" ");

    const entry = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "instance:alpha");
    assert.equal(entry?.expandedLines.some((line) => line.text === "[ Attach Shell ]"), true);
    assert.equal(entry?.expandedLines.some((line) => line.text === "[ Open Config ]"), true);
    assert.equal(entry?.expandedLines.some((line) => line.text === "[ Open Connector ]"), true);
});

test("Prompt 3 detail line selection clamps to a valid line after data replacement", async () => {
    const harness = createHarness();

    await harness.press("5");
    await harness.press("", { tab: true });
    await harness.press(" ");
    await harness.press("", { downArrow: true });

    const key = "logs:alpha:logs";
    assert.equal(harness.store.getState().interaction.selectedDetailLineIds[key], "logs:stdout:2");
    harness.store.replaceLogs("alpha", []);

    const logsBox = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "logs");
    assert.equal(logsBox?.selectedDetailLineId, logsBox?.expandedLines[0]?.id);
    assert.equal(logsBox?.selectedDetailLineId, "logs:No");
});

test("connector editor presents unavailable endpoints and control runtime limits as user states", async () => {
    const harness = createHarness();

    await harness.press("3");
    const connector = selectMainScreenModel(harness.store.getState());
    assert.deepEqual(
        connector.boxes.map((box) => box.title),
        ["MCP Endpoint", "Public Base URL", "Auth", "Endpoint Preview", "Validation"]
    );
    assert.equal(
        connector.boxes.some((box) => box.expandedLines.some((line) => line.text === "runtime=notAvailable")),
        true
    );
    const endpointPreview = connector.boxes.find((box) => box.id === "endpoint-preview");
    assert.deepEqual(endpointPreview?.collapsedLines.map((line) => line.text), ["endpoint=unavailable", "reason=missing publicBaseUrl"]);

    harness.store.setConfigView({
        instances: [{ mcp: { enabled: true, path: "/alpha/custom-mcp" }, name: "alpha", provider: "local" }],
        mcp: { auth: { mode: "none" }, enabled: true, listenHost: "127.0.0.1", listenPort: 3210, publicBaseUrl: "https://example.test/tunnel" }
    });
    const configuredEndpoint = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "endpoint-preview");
    assert.deepEqual(configuredEndpoint?.collapsedLines.map((line) => line.text), ["endpoint=https://example.test/tunnel/alpha/custom-mcp"]);

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

test("Pending Approval Enter opens an isolated approval detail without a tool form or action menu", async () => {
    const harness = createHarness();

    await harness.press("4");
    await harness.press("", { tab: true });
    await harness.press("", { downArrow: true });
    const audit = selectMainScreenModel(harness.store.getState()).boxes[0]!;
    assert.equal(audit.title, "Audit 1");
    assert.equal(audit.expandedLines[0]?.text, "Pending approval:");
    assert.equal(audit.expandedLines.some((line) => line.text === "Enter approval review"), true);
    harness.store.setActionMenu("Actions", [{ id: "tool", intent: { type: "actionMenu.open" }, label: "Call Tool" }]);
    harness.store.setToolForm("alpha", "bash_run", '{"command":""}');
    await harness.press("", { return: true });

    const state = harness.store.getState();
    assert.equal(state.interaction.auditPage.mode, "approvalDetail");
    assert.equal(state.interaction.auditPage.approvalId, "approval-1");
    assert.equal(state.interaction.auditPage.selectedAction, "approve");
    assert.equal(state.interaction.focusScope, "approvalDetail");
    assert.equal(state.interaction.actionMenu.open, false);
    assert.equal(state.interaction.toolForm, undefined);
    assert.deepEqual(harness.approvalDecisions(), []);
});

test("approval detail approves directly and deny requires a Back-focused confirmation", async () => {
    const harness = createHarness();

    await harness.press("4");
    await harness.press("", { tab: true });
    await harness.press("", { downArrow: true });
    await harness.press("", { return: true });
    await harness.press("", { return: true });

    assert.deepEqual(harness.approvalDecisions(), [{ approvalId: "approval-1", decision: "approve", instance: "alpha" }]);
    assert.equal(harness.store.getState().interaction.auditPage.mode, "list");

    await harness.press("", { return: true });
    await harness.press("", { downArrow: true });
    await harness.press("", { return: true });

    assert.equal(harness.store.getState().interaction.auditPage.mode, "denyConfirm");
    assert.equal(harness.store.getState().interaction.auditPage.selectedAction, "back");
    await harness.press("", { upArrow: true });
    await harness.press("", { return: true });

    assert.deepEqual(harness.approvalDecisions(), [
        { approvalId: "approval-1", decision: "approve", instance: "alpha" },
        { approvalId: "approval-1", decision: "deny", instance: "alpha" }
    ]);
    assert.equal(harness.store.getState().interaction.auditPage.mode, "list");
});

test("approval detail Back restores the audit list focus and scroll position", async () => {
    const harness = createHarness();

    await harness.press("4");
    await harness.press("", { tab: true });
    await harness.press("", { downArrow: true });
    harness.store.setScrollOffset("audit:alpha:main", 3);
    await harness.press("", { return: true });
    await harness.press("", { downArrow: true });
    await harness.press("", { downArrow: true });
    await harness.press("", { return: true });

    assert.equal(harness.store.getState().interaction.auditPage.mode, "list");
    assert.equal(harness.store.getState().ui.mainFocusId, "audit-call-1");
    assert.equal(harness.store.getState().ui.scrollOffsets["audit:alpha:main"], 3);
    assert.deepEqual(harness.approvalDecisions(), []);

    await harness.press("", { return: true });
    await harness.press("[", { ctrl: true });
    assert.equal(harness.store.getState().interaction.auditPage.mode, "list");
    assert.equal(harness.store.getState().ui.mainFocusId, "audit-call-1");
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

async function openCreateWizard(harness: ReturnType<typeof createHarness>): Promise<void> {
    await harness.press("", { tab: true });
    await harness.press(" ");
    for (let index = 0; index < 9; index += 1) {
        await harness.press("", { downArrow: true });
    }
    await harness.press("", { return: true });
}

function createHarness(options: {
    onAttachShell?: (instance: string) => Promise<void>;
    onToolCall?: (instance: string, toolName: string, input: string) => Promise<boolean>;
    onValidateConfigDraft?: () => Promise<void>;
    onValidateInstanceCreateDraft?: () => Promise<unknown>;
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
        onGetInstanceCreateSchema: async () => ({
            container: {
                defaultMode: "preset" as const,
                modes: ["preset", "dockerfile", "compose", "existingImage", "existingStoppedContainer"] as const,
                presets: []
            },
            defaultAllowTools: ["bash_run"],
            defaultEnabled: true,
            defaultMcpEnabled: true,
            defaultProvider: "local" as const,
            defaultSecurityMode: "disabled",
            providers: ["local", "ssh", "docker", "podman"] as const
        }),
        onValidateInstanceCreateDraft: options.onValidateInstanceCreateDraft as never,
        onValidateConfigDraft: options.onValidateConfigDraft,
        store
    });
    const keyDispatcher = new KeyDispatcher();

    focusManager.syncPanel(store.getState().ui.selectedPage, store.getState().interaction.focusScope);

    return {
        async dispatch(intent: Parameters<CommandDispatcher["dispatch"]>[0]) {
            await commandDispatcher.dispatch(intent);
        },
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
