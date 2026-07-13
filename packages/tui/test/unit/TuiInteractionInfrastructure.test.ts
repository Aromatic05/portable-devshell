import assert from "node:assert/strict";
import test from "node:test";

import { renderExpandableBoxLines, wrapTerminalText } from "../../dist/component/ExpandableBox.js";
import { isTerminalSizeSupported, mainInnerWidth, tuiLayoutMetrics } from "../../dist/app/TuiRootLayout.js";
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
        ["instances", "config", "connector", "oauth", "audit", "logs", "todo", "help"]
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

    for (let index = 0; index < 8; index += 1) {
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

test("page shortcuts include Todo and Help and reload works on every page", async () => {
    const harness = createHarness();

    await harness.press("8");
    assert.equal(harness.store.getState().ui.selectedPage, "help");

    for (const shortcut of ["1", "2", "3", "4", "5", "6", "7", "8"]) {
        await harness.press(shortcut);
        await harness.press("r");
    }

    assert.deepEqual(harness.pageReloads(), [
        { instance: "alpha", page: "instances" },
        { instance: "alpha", page: "config" },
        { instance: "alpha", page: "connector" },
        { instance: "alpha", page: "oauth" },
        { instance: "alpha", page: "audit" },
        { instance: "alpha", page: "logs" },
        { instance: "alpha", page: "todo" },
        { instance: "alpha", page: "help" }
    ]);
});

test("Help describes the implemented navigation and editing actions", () => {
    const harness = createHarness();
    harness.store.setSelectedPage("help");

    const help = selectMainScreenModel(harness.store.getState()).boxes;
    const actionLines = help.find((box) => box.id === "help-readonly")?.expandedLines.map((line) => line.text) ?? [];
    const navigationLines = help.find((box) => box.id === "help-navigation")?.expandedLines.map((line) => line.text) ?? [];

    assert.equal(actionLines.some((line) => line.includes("Use a to open")), false);
    assert.equal(actionLines.some((line) => line.includes("create, attach, start, restart, stop, or delete")), true);
    assert.equal(actionLines.some((line) => line.includes("Ctrl+S")), true);
    assert.equal(navigationLines.some((line) => line.includes("1-8 switch pages")), true);
});

test("search filters instances, config, audit, and logs only", async () => {
    const harness = createHarness();

    await harness.press("/");
    await harness.press("b");
    await harness.press("e");
    await harness.press("t");
    await harness.press("a");
    assert.deepEqual(selectMainScreenModel(harness.store.getState()).boxes.map((box) => box.id), ["instances-filter-status", "instance:beta"]);
    await harness.press("", { return: true });

    await harness.press("2");
    await harness.press("/");
    for (const character of "workspace") {
        await harness.press(character);
    }
    assert.deepEqual(selectMainScreenModel(harness.store.getState()).boxes.map((box) => box.id), ["config-filter-status", "configuration"]);
    await harness.press("", { return: true });

    await harness.press("5");
    await harness.press("/");
    for (const character of "bash_run") {
        await harness.press(character);
    }
    assert.deepEqual(selectMainScreenModel(harness.store.getState()).boxes.map((box) => box.id), ["audit-filter-status", "approval-approval-1", "audit-call-1"]);
    await harness.press("", { return: true });

    await harness.press("6");
    await harness.press("/");
    for (const character of "line 20") {
        await harness.press(character);
    }
    const logs = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "logs");
    assert.deepEqual(logs?.expandedLines.map((line) => line.text), ["2026-07-09T00:00:19.000Z stdout #20 alpha line 20"]);
    await harness.press("", { return: true });

    await harness.press("3");
    await harness.press("/");
    assert.equal(harness.store.getState().interaction.search.open, false);
});

test("audit structured filters and persistent filter controls work", async () => {
    const harness = createHarness();

    await harness.press("5");
    harness.store.setSearchQuery("audit", "risk:high source:tui tool:bash_run");
    let boxes = selectMainScreenModel(harness.store.getState()).boxes;
    assert.equal(boxes[0]?.id, "audit-filter-status");
    assert.equal(boxes.some((box) => box.id === "approval-approval-1"), true);
    assert.equal(boxes.some((box) => box.id === "audit-call-1"), false);

    harness.store.setSearchQuery("audit", "status:completed source:tui tool:bash_run");
    boxes = selectMainScreenModel(harness.store.getState()).boxes;
    assert.equal(boxes.some((box) => box.id === "audit-call-1"), true);

    harness.store.setSearchQuery("audit", "status:failed");
    boxes = selectMainScreenModel(harness.store.getState()).boxes;
    assert.deepEqual(boxes.map((box) => box.id), ["audit-filter-status"]);

    harness.store.setMainFocusId("audit-filter-status");
    harness.store.setFocusScope("mainBoxes");
    harness.store.toggleExpanded("audit:alpha:audit-filter-status");
    harness.store.setSelectedDetailLine("audit:alpha:audit-filter-status", "audit-filter-status:button:clear-filter");
    await harness.dispatch({ type: "focus.activate" });
    assert.equal(harness.store.getState().ui.searchQueries.audit, "");
});


test("Todo uses a dedicated instance-scoped page and does not appear in Instances boxes", async () => {
    const harness = createHarness();

    const instanceBoxes = selectMainScreenModel(harness.store.getState()).boxes;
    assert.equal(instanceBoxes.some((box) => box.collapsedLines.some((line) => line.text.includes("Todo"))), false);

    await harness.press("7");
    const todoPage = selectMainScreenModel(harness.store.getState());
    assert.equal(todoPage.activePage.page, "todo");
    assert.equal(todoPage.activePage.instance, "alpha");
    assert.deepEqual(todoPage.boxes.map((box) => box.id), [
        "todo-summary",
        "todo-item:inspect",
        "todo-item:implement",
        "todo-item:verify"
    ]);
    assert.deepEqual(todoPage.boxes[0]?.collapsedLines.map((line) => line.text), [
        "progress=1/3  revision=2",
        "Current: Implement Todo"
    ]);
});

test("shifted number shortcuts switch the selected instance without coupling Instances box focus", async () => {
    const harness = createHarness();

    await harness.press("@", { shift: true });
    assert.equal(harness.store.getState().ui.selectedInstance, "beta");
    assert.equal(harness.store.getState().interaction.sidebarCursor?.kind, "instance");
    assert.equal(harness.store.getState().interaction.sidebarCursor?.id, "beta");

    await harness.press("1");
    await harness.press("", { tab: true });
    await harness.press("", { downArrow: true });
    assert.equal(harness.store.getState().ui.mainFocusId, "instance:alpha");
    assert.equal(harness.store.getState().ui.selectedInstance, "beta");
});

test("instance lifecycle buttons are disabled from runtime and command state", async () => {
    const harness = createHarness();

    await harness.press("", { tab: true });
    await harness.press("", { downArrow: true });
    await harness.press(" ");
    let alpha = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "instance:alpha")!;
    assert.notEqual(alpha.expandedLines.find((line) => line.text === "[ Restart ]")?.disabled, true);
    assert.notEqual(alpha.expandedLines.find((line) => line.text === "[ Stop ]")?.disabled, true);

    harness.store.upsertCommand({
        commandId: "busy-alpha",
        sourcePanel: "instances",
        startedAt: "2026-07-10T00:00:00.000Z",
        status: "running",
        targetInstance: "alpha",
        title: "Restart Worker: alpha"
    });
    alpha = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "instance:alpha")!;
    assert.equal(alpha.expandedLines.find((line) => line.text === "[ Restart ]")?.disabled, true);
    assert.equal(alpha.expandedLines.find((line) => line.text === "[ Stop ]")?.disabled, true);

    harness.store.setSelectedDetailLine("instances:alpha:instance", "instance:alpha:button:restart");
    await harness.dispatch({ type: "focus.activate" });
    assert.deepEqual(harness.instanceActions(), []);
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
    assert.equal(harness.store.getState().ui.expandedBoxes[expandedKey], true);
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");

    await harness.press(" ");
    assert.equal(harness.store.getState().ui.expandedBoxes[expandedKey], false);
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

test("box rendering wraps Unicode text by terminal display width", () => {
    assert.deepEqual(wrapTerminalText("配置 😀 long-value", 8), ["配置 😀", "long-val", "ue"]);

    const lines = renderExpandableBoxLines({
        collapsedLines: [{ text: "01234567890123456789012345" }],
        expanded: false,
        expandedKey: "test",
        expandedLines: [],
        focused: false,
        id: "test",
        status: "normal",
        title: "测试"
    }, 24);

    assert.equal(lines.length, 4);
    assert.equal(lines[1]?.text, "│ 012345678901234567890123 │");
    assert.equal(lines[2]?.text, "│ 45                       │");
});

test("narrow terminals use compact navigation and reject unsupported sizes", () => {
    assert.equal(tuiLayoutMetrics(120).mode, "full");
    assert.equal(tuiLayoutMetrics(80).mode, "compact");
    assert.equal(mainInnerWidth(80), 76);
    assert.equal(isTerminalSizeSupported(80, 20), true);
    assert.equal(isTerminalSizeSupported(59, 20), false);
    assert.equal(isTerminalSizeSupported(80, 13), false);

    const harness = createHarness();
    assert.deepEqual(buildTuiHitRegions(harness.store.getState(), { columns: 59, rows: 20 }), []);
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

    const configuration = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "configuration");
    assert.equal(configuration?.expandedLines.some((line) => line.text === "error: workspace must be an absolute path"), true);
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

    const general = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "configuration");
    const security = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "security");
    assert.equal(general?.expandedLines.some((line) => line.text.endsWith("<local>")), true);
    assert.equal(security?.expandedLines.some((line) => line.text.endsWith("<disabled>")), true);
    assert.equal(security?.expandedLines.some((line) => line.text.endsWith("<ask>")), true);

    await harness.press("", { downArrow: true });
    await harness.press("", { rightArrow: true });
    assert.equal((harness.store.getState().ui.formDrafts["config:alpha"] as { provider?: unknown }).provider, "ssh");
    await harness.press("", { leftArrow: true });
    assert.equal((harness.store.getState().ui.formDrafts["config:alpha"] as { provider?: unknown }).provider, "local");
});

test("config exposes reload, save-only, and save-and-restart semantics", async () => {
    const harness = createHarness();

    await harness.press("2");
    await harness.press("", { tab: true });
    await harness.press(" ");
    await harness.press("", { downArrow: true });
    await harness.press("", { return: true });

    const actions = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "configuration-actions")!;
    assert.equal(actions.expandedLines.some((line) => line.text === "[ Reload ]"), true);
    assert.equal(actions.expandedLines.some((line) => line.text === "[ Save Only ]"), true);
    assert.equal(actions.expandedLines.some((line) => line.text === "[ Save & Restart ]"), true);

    harness.store.setFormDraft("config:alpha", {
        ...(harness.store.getState().ui.formDrafts["config:alpha"] as Record<string, unknown>),
        provider: "ssh"
    });
    const changed = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "configuration-actions")!;
    assert.equal(changed.expandedLines.find((line) => line.text === "[ Save Only ]")?.disabled, true);
    assert.equal(changed.expandedLines.some((line) => line.text === "Apply mode          restart required"), true);
});

test("config separates MCP tool access and requires restart when it changes", async () => {
    const harness = createHarness();

    await harness.press("2");
    await harness.press("", { tab: true });
    await harness.press(" ");
    await harness.press("", { downArrow: true });
    await harness.press("", { return: true });
    harness.store.setFormDraft("config:alpha", {
        ...(harness.store.getState().ui.formDrafts["config:alpha"] as Record<string, unknown>),
        mcp: { enabled: true, path: "/alpha/mcp", tools: { capabilities: ["read"], groups: ["file"] } }
    });

    const boxes = selectMainScreenModel(harness.store.getState()).boxes;
    const mcpTools = boxes.find((box) => box.id === "mcp-tools")!;
    const actions = boxes.find((box) => box.id === "configuration-actions")!;
    assert.equal(mcpTools.title, "MCP Tool Access");
    assert.equal(mcpTools.expandedLines.some((line) => line.text.includes("file")), true);
    assert.equal(mcpTools.expandedLines.some((line) => line.text.includes("read")), true);
    assert.equal(actions.expandedLines.some((line) => line.text === "Apply mode          restart required"), true);
});

test("config exposes container and tool scheduler settings", async () => {
    const harness = createHarness();

    await harness.press("2");
    harness.store.setFormDraft("config:alpha", {
        container: { build: { context: "/workspace/alpha", dockerfile: "Dockerfile.dev" }, mode: "dockerfile", preset: "ubuntu" },
        enabled: true,
        mcp: { enabled: true, path: "/alpha/mcp", tools: { capabilities: ["read"], groups: ["file"] } },
        name: "alpha",
        provider: "docker",
        security: { mode: "disabled" },
        tools: { fileEdit: { mode: "patch" }, scheduler: { maxRunning: 2, queueDepth: 8, queueTimeoutMs: 3000 } },
        workspace: "/workspace/alpha"
    });

    const boxes = selectMainScreenModel(harness.store.getState()).boxes;
    const provider = boxes.find((box) => box.id === "provider")!;
    const runtime = boxes.find((box) => box.id === "tool-runtime")!;
    assert.equal(provider.expandedLines.some((line) => line.text.includes("Dockerfile.dev")), true);
    assert.equal(provider.expandedLines.some((line) => line.text.includes("/workspace/alpha")), true);
    assert.equal(runtime.expandedLines.some((line) => line.text.includes("2")), true);
    assert.equal(runtime.expandedLines.some((line) => line.text.includes("3000")), true);
});

test("audit keeps input in its original box line and opens structured patch details", async () => {
    const harness = createHarness();
    const patch = "*** Begin Patch\n*** Update File: src/example.ts\n-old\n+new\n*** End Patch";

    harness.store.applyEvent({
        event: "toolCall.queued",
        payload: { at: "2026-07-14T00:00:00.000Z", data: { callId: "live-patch", input: { input: patch }, inputSummary: JSON.stringify({ input: patch }), source: "mcp", startedAt: "2026-07-14T00:00:00.000Z", status: "queued", toolName: "file_edit" } },
        seq: 21,
        target: { instance: "alpha" as never, kind: "instance" },
        type: "event"
    });
    harness.store.applyEvent({
        event: "toolCall.completed",
        payload: { at: "2026-07-14T00:00:01.000Z", data: { callId: "live-patch", completedAt: "2026-07-14T00:00:01.000Z", source: "mcp", startedAt: "2026-07-14T00:00:00.000Z", status: "completed", toolName: "file_edit" } },
        seq: 22,
        target: { instance: "alpha" as never, kind: "instance" },
        type: "event"
    });
    await harness.press("5");

    const audit = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "audit-live-patch")!;
    assert.equal((harness.store.getState().toolCallsByInstance.alpha ?? []).find((record) => record.callId === "live-patch")?.input !== undefined, true);
    assert.equal(audit.expandedLines.some((line) => line.text.includes("*** Begin Patch")), true);
    assert.equal(audit.expandedLines.some((line) => line.text === "[ View Full Input ]"), false);

    harness.store.toggleExpanded(audit.expandedKey);
    harness.store.setFocusScope("boxDetail");
    harness.store.setMainFocusId("audit-live-patch");
    harness.store.setSelectedDetailLine(audit.expandedKey, "audit-live-patch:input");
    await harness.dispatch({ type: "focus.activate" });
    assert.equal(harness.store.getState().interaction.textDetail.open, true);
    assert.equal(harness.store.getState().interaction.textDetail.body.includes("*** Begin Patch"), true);
});

test("audit renders legacy records without an input summary", async () => {
    const harness = createHarness();
    harness.store.replaceToolCalls("alpha", [{
        callId: "legacy-call",
        instance: "alpha",
        source: "mcp",
        startedAt: "2026-07-14T00:00:00.000Z",
        status: "completed",
        toolName: "bash_run"
    } as never]);

    await harness.press("5");

    const audit = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "audit-legacy-call")!;
    assert.equal(audit.expandedLines.some((line) => line.text === "input -"), true);
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

test("expanded instance entries expose only compact lifecycle controls", async () => {
    const harness = createHarness();

    await harness.press("", { tab: true });
    await harness.press("", { downArrow: true });
    await harness.press(" ");

    const entry = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "instance:alpha");
    const lines = entry?.expandedLines.map((line) => line.text) ?? [];
    assert.equal(lines.includes("[ Attach Shell ]"), true);
    assert.equal(lines.includes("[ Restart ]"), true);
    assert.equal(lines.includes("[ Stop ]"), true);
    assert.equal(lines.includes("[ Delete ]"), true);
    assert.equal(lines.some((line) => line.includes("enabled") && line.includes("yes")), true);
    assert.equal(lines.some((line) => line.includes("mcpPath")), false);
    assert.equal(lines.some((line) => line.includes("lastError")), false);
    assert.equal(lines.includes("[ Open Config ]"), false);
    assert.equal(lines.includes("[ Open Connector ]"), false);
    assert.equal(entry?.collapsedLines[0]?.text.includes("daemon="), false);
    assert.equal(entry?.collapsedLines[0]?.text.includes("rpc="), false);
    assert.equal(entry?.collapsedLines[0]?.text.includes("ready="), false);
});

test("Prompt 3 detail line selection clamps to a valid line after data replacement", async () => {
    const harness = createHarness();

    await harness.press("6");
    await harness.press("", { tab: true });
    harness.store.setMainFocusId("logs");
    await harness.press(" ");
    await harness.press("", { downArrow: true });

    const key = "logs:alpha:logs";
    assert.equal(harness.store.getState().interaction.selectedDetailLineIds[key], "logs:log:2");
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
        ["[Instance] MCP Endpoint", "[Global] Public Base URL", "[Global] Auth", "Page Actions", "Configured Endpoint", "Configuration Validation"]
    );
    assert.equal(
        connector.boxes.some((box) => box.expandedLines.some((line) => line.text === "MCP runtime        stopped")),
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

    await harness.press("6");
    assert.equal(harness.logsReloadCount(), 1);
    const logs = selectMainScreenModel(harness.store.getState());
    assert.equal(logs.activePage.page, "logs");
    assert.equal(logs.activePage.instance, "alpha");
    assert.equal(logs.boxes[0]?.collapsedLines[0]?.text, "follow=on  visible=20  new=0");
    assert.equal(logs.boxes.some((box) => box.title === "Source"), false);

    await harness.press("8");
    assert.equal(selectHelpLines(harness.store.getState()).some((line) => line.includes("directly inside each expanded instance box")), true);
});

test("connector page actions expose and save only affected scopes", async () => {
    const instanceUpdates: unknown[] = [];
    const mcpUpdates: unknown[] = [];
    const harness = createHarness({
        onInstanceConfigUpdate: async (value) => { instanceUpdates.push(value); return {}; },
        onMcpConfigUpdate: async (value) => { mcpUpdates.push(value); return {}; }
    });

    await harness.press("3");
    await harness.press("", { tab: true });
    await harness.press(" ");
    harness.store.setFormDraft("connector:alpha", { auth: { mode: "none" }, enabled: true, listenHost: "127.0.0.1", listenPort: 3210 }, true);
    const actions = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "connector-actions")!;
    assert.equal(actions.expandedLines.some((line) => line.text === "Affected scopes    global"), true);
    harness.store.setMainFocusId(actions.id);
    harness.store.setFocusScope("mainBoxes");
    if (!actions.expanded) {
        harness.store.toggleExpanded(actions.expandedKey);
    }
    harness.store.setSelectedDetailLine(actions.expandedKey, "connector-actions:button:save");
    await harness.dispatch({ type: "focus.activate" });
    assert.equal(instanceUpdates.length, 0);
    assert.equal(mcpUpdates.length, 1);
});

test("long detail lines open a wrapped full-text viewer", async () => {
    const harness = createHarness();
    harness.store.replaceOAuthApprovals([{
        approvalId: "oauth-long",
        clientId: "client-long",
        clientName: "Long Client",
        createdAt: "2026-07-10T00:00:00.000Z",
        expiresAt: "2026-07-10T00:05:00.000Z",
        kind: "authorization",
        redirectUris: ["https://example.test/callback/with/a/very/long/path/that/does/not/fit/in/a/single/terminal/line"],
        requestedResources: [],
        requestedScopes: ["mcp"],
        status: "approved"
    }]);

    await harness.press("4");
    await harness.press("", { tab: true });
    const approval = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "oauth-approval-oauth-long")!;
    harness.store.setMainFocusId(approval.id);
    harness.store.toggleExpanded(approval.expandedKey);
    harness.store.setSelectedDetailLine(approval.expandedKey, `${approval.id}:redirectUris`);
    await harness.dispatch({ type: "focus.activate" });

    assert.equal(harness.store.getState().interaction.focusScope, "textDetail");
    assert.equal(harness.store.getState().interaction.textDetail.open, true);
    assert.match(harness.store.getState().interaction.textDetail.body, /very\/long\/path/u);
    await harness.press("", { return: true });
    assert.equal(harness.store.getState().interaction.textDetail.open, false);
});

test("OAuth panel approves pending registration requests", async () => {
    const harness = createHarness();
    harness.store.replaceOAuthApprovals([
        {
            approvalId: "oauth-1",
            clientId: "chatgpt-client",
            clientName: "ChatGPT",
            createdAt: "2026-07-10T00:00:00.000Z",
            expiresAt: "2026-07-10T00:05:00.000Z",
            kind: "registration",
            redirectUris: ["https://chatgpt.com/callback"],
            requestedResources: [],
            requestedScopes: [],
            status: "pending"
        }
    ]);

    await harness.press("4");
    const approval = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "oauth-approval-oauth-1")!;
    assert.equal(approval.title, "OAuth registration approval");
    harness.store.toggleExpanded(approval.expandedKey);
    harness.store.setMainFocusId(approval.id);
    harness.store.setFocusScope("boxDetail");
    harness.store.setSelectedDetailLine(approval.expandedKey, `${approval.id}:oauth.approve:oauth-1`);

    await harness.press("", { return: true });
    assert.equal(harness.store.getState().interaction.confirmDialog.title, "Confirm OAuth Approval");
    assert.deepEqual(harness.oauthApprovalDecisions(), []);
    await harness.press("", { rightArrow: true });
    await harness.press("", { return: true });
    assert.deepEqual(harness.oauthApprovalDecisions(), [{ approvalId: "oauth-1", decision: "approve" }]);
});

test("OAuth detail keeps static rows selectable after expanding a completed approval", async () => {
    const harness = createHarness();
    harness.store.replaceOAuthApprovals([
        {
            approvalId: "oauth-completed",
            clientId: "completed-client",
            clientName: "Completed Client",
            createdAt: "2026-07-10T00:00:00.000Z",
            expiresAt: "2026-07-10T00:05:00.000Z",
            kind: "authorization",
            redirectUris: ["http://localhost:53242/callback"],
            requestedResources: ["https://example.test/mcp"],
            requestedScopes: ["mcp"],
            status: "approved"
        }
    ]);

    await harness.press("4");
    await harness.press("", { tab: true });
    const approval = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "oauth-approval-oauth-completed")!;
    harness.store.setMainFocusId(approval.id);
    await harness.press(" ");

    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");
    assert.equal(harness.store.getState().interaction.selectedDetailLineIds[approval.expandedKey], `${approval.id}:kind`);

    await harness.press("", { downArrow: true });
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");
    assert.equal(harness.store.getState().interaction.selectedDetailLineIds[approval.expandedKey], `${approval.id}:client`);

    await harness.press("", { upArrow: true });
    assert.equal(harness.store.getState().interaction.selectedDetailLineIds[approval.expandedKey], `${approval.id}:kind`);
});

test("logs render timestamps and correlation metadata", () => {
    const harness = createHarness();
    harness.store.replaceLogs("alpha", [{
        at: "2026-07-11T12:34:56.000Z",
        callId: "call-1",
        instance: "alpha",
        message: "done",
        receivedAt: "2026-07-11T12:34:56.000Z",
        requestId: "req-1",
        seq: 21,
        sessionId: "session-1",
        source: "mcp",
        stream: "stdout",
        toolName: "bash_run"
    }]);
    harness.store.setSelectedPage("logs");
    const logs = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "logs")!;
    assert.equal(logs.expandedLines[0]?.text, "2026-07-11T12:34:56.000Z stdout #21 tool=bash_run call=call-1 request=req-1 session=session-1 source=mcp done");
});

test("Logs controls expose statistics and real follow state", async () => {
    const harness = createHarness();

    await harness.press("6");
    await harness.press("", { tab: true });
    await harness.press(" ");
    const controls = selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "logs-controls")!;
    assert.equal(controls.title, "Log Controls & Statistics");
    assert.equal(controls.expandedLines.some((line) => line.text === "Follow             on"), true);
    assert.equal(controls.expandedLines.some((line) => line.text === "Total              20"), true);

    harness.store.setSelectedDetailLine(controls.expandedKey, "logs-controls:button:toggle-follow");
    await harness.dispatch({ type: "focus.activate" });
    assert.equal(harness.store.getState().ui.logsFollowByInstance.alpha, false);

    await harness.dispatch({ type: "logs.toggleFollow" });
    assert.equal(harness.store.getState().ui.logsFollowByInstance.alpha, true);
    await harness.dispatch({ type: "screen.pageUp" });
    assert.equal(harness.store.getState().ui.logsFollowByInstance.alpha, false);
});

test("Main viewport scrolling uses one page-instance offset instead of per-box offsets", async () => {
    const harness = createHarness();

    await harness.press("6");
    await harness.press("", { tab: true });
    harness.store.setMainFocusId("logs");
    await harness.press(" ");
    await harness.press("", { pageDown: true });

    assert.equal(harness.store.getState().ui.scrollOffsets["logs:alpha:logs"], undefined);
    assert.equal((harness.store.getState().ui.scrollOffsets["logs:alpha:main"] ?? 0) > 0, true);
    assert.equal(selectMainScreenModel(harness.store.getState()).boxes.find((box) => box.id === "logs")?.expandedLines.length, 20);
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

test("instance Stop is direct in the box and defaults to Cancel", async () => {
    const harness = createHarness();

    await harness.press("", { tab: true });
    await harness.press("", { downArrow: true });
    await harness.press(" ");
    harness.store.setSelectedDetailLine("instances:alpha:instance", "instance:alpha:button:stop");
    await harness.dispatch({ type: "focus.activate" });

    assert.equal(harness.store.getState().interaction.focusScope, "confirm");
    assert.equal(harness.store.getState().interaction.selectedConfirmButton, "cancel");
    await harness.press("", { return: true });
    assert.deepEqual(harness.instanceActions(), []);
});

test("enabled toggle disables through confirmation and enables directly", async () => {
    const harness = createHarness();

    await harness.press("", { tab: true });
    await harness.press("", { downArrow: true });
    await harness.press(" ");
    harness.store.setSelectedDetailLine("instances:alpha:instance", "instance:alpha:instance.toggleEnabled:alpha");
    await harness.dispatch({ type: "focus.activate" });
    assert.equal(harness.store.getState().interaction.confirmDialog.title, "Confirm Disable");
    await harness.press("", { rightArrow: true });
    await harness.press("", { return: true });
    assert.deepEqual(harness.enabledChanges(), [{ enabled: false, instance: "alpha" }]);

    harness.store.replaceInstances(harness.store.getState().instances.map((entry) => entry.name === "alpha" ? { ...entry, enabled: false } : entry));
    harness.store.setFocusScope("mainBoxes");
    harness.store.setMainFocusId("instance:alpha");
    harness.store.setSelectedDetailLine("instances:alpha:instance", "instance:alpha:instance.toggleEnabled:alpha");
    await harness.dispatch({ type: "focus.activate" });
    assert.deepEqual(harness.enabledChanges(), [
        { enabled: false, instance: "alpha" },
        { enabled: true, instance: "alpha" }
    ]);
});

test("Pending Approval Enter opens an isolated approval detail without a tool form", async () => {
    const harness = createHarness();

    await harness.press("5");
    await harness.press("", { tab: true });
    const audit = selectMainScreenModel(harness.store.getState()).boxes[0]!;
    assert.equal(audit.title, "Pending Approval 1 · bash_run");
    assert.equal(audit.expandedLines.some((line) => line.text === "[ Review ]"), true);
    harness.store.setToolForm("alpha", "bash_run", '{"command":""}');
    await harness.press("", { return: true });

    const state = harness.store.getState();
    assert.equal(state.interaction.auditPage.mode, "approvalDetail");
    assert.equal(state.interaction.auditPage.approvalId, "approval-1");
    assert.equal(state.interaction.auditPage.selectedAction, "back");
    assert.equal(state.interaction.focusScope, "approvalDetail");
    assert.equal(state.interaction.toolForm, undefined);
    assert.deepEqual(harness.approvalDecisions(), []);
});

test("approval detail defaults to Back and requires explicit approval confirmation", async () => {
    const harness = createHarness();

    await harness.press("5");
    await harness.press("", { tab: true });
    await harness.press("", { return: true });
    assert.equal(harness.store.getState().interaction.auditPage.selectedAction, "back");

    await harness.press("", { downArrow: true });
    await harness.press("", { downArrow: true });
    await harness.press("", { downArrow: true });
    await harness.press("", { return: true });
    assert.equal(harness.store.getState().interaction.focusScope, "confirm");
    assert.equal(harness.store.getState().interaction.confirmDialog.title, "Confirm Approval");
    assert.deepEqual(harness.approvalDecisions(), []);

    await harness.press("", { rightArrow: true });
    await harness.press("", { return: true });
    assert.deepEqual(harness.approvalDecisions(), [{ approvalId: "approval-1", decision: "approve", instance: "alpha" }]);
    assert.equal(harness.store.getState().interaction.auditPage.mode, "list");
});

test("approval detail opens the associated structured input before a decision", async () => {
    const harness = createHarness();

    await harness.press("5");
    await harness.press("", { tab: true });
    await harness.press("", { return: true });
    await harness.press("", { downArrow: true });
    await harness.press("", { return: true });

    assert.equal(harness.store.getState().interaction.focusScope, "textDetail");
    assert.equal(harness.store.getState().interaction.textDetail.title, "bash_run · approval input");
    assert.match(harness.store.getState().interaction.textDetail.body, /cmd:/u);
    assert.deepEqual(harness.approvalDecisions(), []);
});

test("approval detail Back restores the audit list focus and scroll position", async () => {
    const harness = createHarness();

    await harness.press("5");
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

test("Attach Shell is invoked directly from the expanded instance box", async () => {
    const harness = createHarness();

    await harness.press("", { tab: true });
    await harness.press("", { downArrow: true });
    await harness.press(" ");
    harness.store.setSelectedDetailLine("instances:alpha:instance", "instance:alpha:button:attach-shell");
    await harness.dispatch({ type: "focus.activate" });

    assert.equal(harness.store.getState().interaction.confirmDialog.title, "UNMANAGED SHELL");
    assert.deepEqual(harness.shellAttaches(), []);
    await harness.press("", { rightArrow: true });
    await harness.press("", { return: true });

    assert.deepEqual(harness.shellAttaches(), ["alpha"]);
});

async function openCreateWizard(harness: ReturnType<typeof createHarness>): Promise<void> {
    await harness.press("", { tab: true });
    await harness.press(" ");
    const createBox = selectMainScreenModel(harness.store.getState()).boxes.find(
        (box) => box.id === "create-instance"
    );
    const createButton = createBox?.expandedLines.find((line) => line.id?.endsWith(":button:create"));
    assert.ok(createBox?.expandedKey);
    assert.ok(createButton?.id);
    harness.store.setSelectedDetailLine(createBox.expandedKey, createButton.id);
    await harness.dispatch({ type: "focus.activate" });
}

function createHarness(options: {
    onAttachShell?: (instance: string) => Promise<void>;
    onOAuthApprovalDecision?: (approvalId: string, decision: "approve" | "deny") => Promise<void>;
    onInstanceConfigUpdate?: (value: Record<string, unknown>) => Promise<void>;
    onMcpConfigUpdate?: (value: Record<string, unknown>) => Promise<void>;
    onToolCall?: (instance: string, toolName: string, input: string) => Promise<boolean>;
    onValidateConfigDraft?: () => Promise<void>;
    onValidateInstanceCreateDraft?: () => Promise<unknown>;
} = {}) {
    const store = new TuiAppStore();
    seedPrompt3State(store);
    const approvalDecisions: Array<{ approvalId: string; decision: string; instance: string }> = [];
    const oauthApprovalDecisions: Array<{ approvalId: string; decision: string }> = [];
    const instanceActions: Array<{ action: string; instance: string }> = [];
    const enabledChanges: Array<{ enabled: boolean; instance: string }> = [];
    const shellAttaches: string[] = [];
    let logsReloadRequests = 0;
    const pageReloads: Array<{ instance: string | undefined; page: string }> = [];
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
        onInstanceEnabledChange: async (instance, enabled) => {
            enabledChanges.push({ enabled, instance });
        },
        onAttachShell: options.onAttachShell ?? (async (instance) => {
            shellAttaches.push(instance);
        }),
        onLogsReload: async () => {
            logsReloadRequests += 1;
        },
        onPageReload: async (page, instance) => {
            pageReloads.push({ instance, page });
        },
        onOAuthApprovalDecision: options.onOAuthApprovalDecision ?? (async (approvalId, decision) => {
            oauthApprovalDecisions.push({ approvalId, decision });
        }),
        onInstanceConfigUpdate: options.onInstanceConfigUpdate as never,
        onMcpConfigUpdate: options.onMcpConfigUpdate as never,
        onApplyConfig: async () => ({}),
        onQuit: async () => undefined,
        onRedraw: () => undefined,
        onToolCall: options.onToolCall ?? (async () => true),
        onGetInstanceCreateSchema: async () => ({
            container: {
                defaultMode: "preset" as const,
                modes: ["preset", "dockerfile", "compose", "existingImage", "existingStoppedContainer"] as const,
                presets: []
            },
            defaultMcpCapabilities: ["read", "write", "execute"],
            defaultMcpGroups: ["file", "bash", "artifact"],
            defaultEnabled: true,
            defaultMcpEnabled: true,
            defaultProvider: "local" as const,
            defaultSecurityMode: "disabled",
            providers: ["local", "ssh", "docker", "podman"] as const
        }),
        onValidateInstanceCreateDraft: options.onValidateInstanceCreateDraft as never,
        onValidateConfigDraft: options.onValidateConfigDraft ?? (async () => undefined),
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
        enabledChanges() {
            return enabledChanges;
        },
        focusManager,
        instanceActions() {
            return instanceActions;
        },
        logsReloadCount() {
            return logsReloadRequests;
        },
        oauthApprovalDecisions() {
            return oauthApprovalDecisions;
        },
        pageReloads() {
            return pageReloads;
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
    store.replaceTodo("alpha", {
        items: [
            { content: "Inspect", id: "inspect", status: "completed" },
            { content: "Implement Todo", detail: "Adding dedicated TUI page", id: "implement", status: "in_progress" },
            { content: "Verify", id: "verify", status: "pending" }
        ],
        revision: 2,
        summary: { completed: 1, currentItemId: "implement", total: 3 },
        taskId: "task-1",
        title: "Todo support"
    });
    store.replaceToolCalls("alpha", [
        {
            callId: "call-1",
            completedAt: "2026-07-09T00:00:01.000Z",
            inputSummary: "{\"cmd\":\"pwd\"}",
            instance: "alpha" as never,
            source: "tui",
            startedAt: "2026-07-09T00:00:00.000Z",
            status: "completed",
            termination: "exited",
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
