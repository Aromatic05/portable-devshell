import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    createError,
    type ContextMessageRecord,
    type InstanceCreateDraft,
    type InstanceCreateSummary,
    type JsonValue,
} from "@portable-devshell/shared";

import {
    buildFocusGraphForState,
    buildTuiHitRegions,
    TuiCommandDispatcher,
    TuiKeyDispatcher,
    selectFooterText,
    selectHelpLines,
    selectMainScreenModel,
    selectSidebarModel,
    hitTargetAt,
    isTerminalSizeSupported,
    mainInnerWidth,
    renderExpandableBoxLines,
    TuiAppStore,
    TuiFocusManager,
    currentTuiRoute,
    selectMainScrollKey,
    topTuiOverlay,
    tuiLayoutMetrics,
    tuiViewProjection,
    wrapTerminalText,
} from "../../src/testing.ts";
import { choiceLine, fieldLine } from "../../src/view/editor/TuiEditorView.ts";

test("Prompt 3 urgent fix uses page + instance coordinates with a two-stage Tab cycle", async () => {
    const harness = createHarness();
    assert.deepEqual(
        selectSidebarModel(harness.store.getState()).pages.map(
            (item) => item.label,
        ),
        [
            "overview",
            "instances",
            "config",
            "connections",
            "audit",
            "logs",
            "todo",
            "help",
            "terminal",
        ],
    );

    await harness.press("", { tab: true });
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");
    await harness.press("", { leftArrow: true });
    assert.equal(
        harness.store.getState().interaction.focusScope,
        "sidebarPages",
    );
    await harness.press("", { rightArrow: true });
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");

    harness.store.setFocusScope("sidebarPages");
    await harness.dispatch({ page: "audit", type: "page.select" });
    assert.equal(harness.store.getState().ui.selectedPage, "audit");
    assert.equal(harness.store.getState().ui.selectedInstance, "alpha");

    assert.equal(
        harness.focusManager.setFocus({ id: "beta", kind: "instance" }),
        true,
    );
    await harness.press("", { return: true });
    assert.equal(harness.store.getState().ui.selectedInstance, "beta");
});
test("page shortcuts include Todo, Help, and Terminal and reload works on every page", async () => {
    const harness = createHarness();
    const shortcuts = [
        ["0", "overview"],
        ["1", "instances"],
        ["2", "config"],
        ["3", "connections"],
        ["4", "audit"],
        ["5", "logs"],
        ["6", "todo"],
        ["7", "help"],
        ["8", "terminal"],
    ] as const;

    for (const [shortcut, page] of shortcuts) {
        await harness.press(shortcut);
        assert.equal(harness.store.getState().ui.selectedPage, page);
        await harness.press("r");
    }

    assert.equal(harness.logsReloadCount(), 1);
    const reloaded = new Set(harness.pageReloads().map((entry) => entry.page));
    for (const page of [
        "overview",
        "instances",
        "config",
        "connections",
        "audit",
        "todo",
        "help",
        "terminal",
    ]) {
        assert.equal(reloaded.has(page), true, `missing reload for ${page}`);
    }
});
test("Overview instance rows open the matching instance page", async () => {
    const harness = createHarness();
    harness.store.replaceOperationalOverview({
        activity: [
            {
                callId: "call-1",
                instance: asInstanceName("alpha"),
                source: "mcp",
                startedAt: "2026-07-31T00:00:00.000Z",
                status: "failed",
                toolName: "bash_run",
            },
        ],
        alerts: [],
        controller: { pid: 1, uptimeSeconds: 60 },
        counts: {
            activeTodos: 1,
            failedCalls24h: 1,
            instancesAttention: 0,
            instancesCritical: 0,
            instancesReady: 1,
            instancesTotal: 1,
            pendingApprovals: 0,
        },
        generatedAt: "2026-07-31T00:00:00.000Z",
        health: "healthy",
        instances: [
            {
                mcpEnabled: true,
                name: asInstanceName("alpha"),
                pendingApprovals: 0,
                provider: "local",
                snapshot: {
                    connectionState: "connected",
                    daemonState: "running",
                    lastSeq: 1,
                    name: asInstanceName("alpha"),
                    ready: true,
                    status: "ready",
                },
            },
        ],
        todos: [
            {
                completed: 0,
                currentItem: "Investigate failure",
                instance: asInstanceName("alpha"),
                revision: 1,
                status: "in_progress",
                taskId: "task-1",
                title: "Recover worker",
                total: 1,
            },
        ],
    });

    await harness.dispatch({ page: "overview", type: "page.select" });
    harness.store.setFocusScope("mainBoxes");
    harness.store.setMainFocusId("overview-instance:alpha");
    await harness.dispatch({ type: "focus.activate" });

    assert.equal(harness.store.getState().ui.selectedPage, "instances");
    assert.equal(harness.store.getState().ui.selectedInstance, "alpha");
    assert.equal(harness.store.getState().ui.mainFocusId, "instance:alpha");
});

test("Help describes the implemented navigation and editing actions", () => {
    const harness = createHarness();
    harness.store.setSelectedPage("help");
    const lines = selectHelpLines(harness.store.getState());
    assert.equal(
        lines.some((line) =>
            line.includes("Tab cycles sidebar and main boxes"),
        ),
        true,
    );
    assert.equal(
        lines.some((line) => line.includes("Space expands and collapses")),
        true,
    );
    assert.equal(
        lines.some(
            (line) =>
                line.includes("Ctrl+[") && line.includes("escape fallback"),
        ),
        true,
    );

    for (const box of selectMainScreenModel(harness.store.getState()).boxes) {
        harness.store.toggleExpanded(box.expandedKey);
    }
    const rendered = selectMainScreenModel(
        harness.store.getState(),
    ).boxes.flatMap((box) => box.expandedLines.map((line) => line.text));
    assert.equal(
        rendered.some((line) => line.includes("1-8 open feature pages")),
        true,
    );
    assert.equal(
        rendered.some((line) => line.includes("Connections fields")),
        true,
    );
});
test("search filters instances, config, audit, and logs only", async () => {
    const harness = createHarness();

    harness.store.setSelectedPage("instances");
    await harness.dispatch({ type: "search.open" });
    await harness.dispatch({ text: "alpha", type: "search.append" });
    assert.deepEqual(
        selectMainScreenModel(harness.store.getState()).boxes.map(
            (box) => box.id,
        ),
        ["instances-filter-status", "instance:alpha"],
    );
    await harness.dispatch({ type: "search.submit" });

    harness.store.setSelectedPage("config");
    await harness.dispatch({ type: "search.open" });
    await harness.dispatch({ text: "workspace", type: "search.append" });
    assert.equal(
        selectMainScreenModel(harness.store.getState()).boxes.some(
            (box) => box.id === "configuration",
        ),
        true,
    );
    await harness.dispatch({ type: "search.submit" });

    harness.store.setSelectedPage("audit");
    await harness.dispatch({ type: "search.open" });
    await harness.dispatch({ text: "bash_run", type: "search.append" });
    assert.deepEqual(
        selectMainScreenModel(harness.store.getState()).boxes.map(
            (box) => box.id,
        ),
        ["audit-filter-status", "audit-context:ctx-alpha"],
    );
    await harness.dispatch({ type: "search.submit" });

    harness.store.setSelectedPage("logs");
    await harness.dispatch({ type: "search.open" });
    await harness.dispatch({ text: "ctx-alpha", type: "search.append" });
    assert.deepEqual(
        selectMainScreenModel(harness.store.getState()).boxes.map(
            (box) => box.id,
        ),
        ["logs-filter-status", "log-context:ctx-alpha"],
    );
    await harness.dispatch({ type: "search.submit" });

    harness.store.setSelectedPage("connections");
    assert.equal(await dispatchResult(harness, { type: "search.open" }), false);
    assert.equal(
        topTuiOverlay(harness.store.getState().interaction.overlays),
        undefined,
    );
});
test("audit structured filters and persistent filter controls work", async () => {
    const harness = createHarness();
    harness.store.setSelectedPage("audit");
    await harness.dispatch({ type: "search.open" });
    await harness.dispatch({
        text: "risk:high tool:bash_run",
        type: "search.append",
    });
    await harness.dispatch({ type: "search.submit" });

    assert.deepEqual(
        selectMainScreenModel(harness.store.getState()).boxes.map(
            (box) => box.id,
        ),
        ["audit-filter-status", "audit-context:ctx-alpha"],
    );
    const filter = expandBox(harness, "audit-filter-status");
    harness.store.setMainFocusId(filter.id);
    harness.store.setFocusScope("boxDetail");
    harness.store.setSelectedDetailLine(
        filter.expandedKey,
        `${filter.id}:button:clear-filter`,
    );
    await harness.dispatch({ type: "focus.activate" });
    assert.equal(harness.store.getState().ui.searchQueries.audit, "");
    assert.deepEqual(
        selectMainScreenModel(harness.store.getState()).boxes.map(
            (box) => box.id,
        ),
        ["audit-context:ctx-alpha"],
    );
});
test("Audit opens Comment conversation only from a concrete context route", async () => {
    const root = createHarness();
    root.store.setSelectedPage("audit");
    await root.press("m");
    assert.deepEqual(currentTuiRoute(root.store.getState()), {
        page: "audit",
        view: "contexts",
    });
    assert.equal(topTuiOverlay(root.store.getState().interaction.overlays), undefined);

    const unscoped = createHarness();
    enableContextMessageMcp(unscoped);
    unscoped.store.setSelectedPage("audit");
    unscoped.store.replaceRoute({
        page: "audit",
        scope: "unscoped",
        view: "context",
    });
    await unscoped.press("m");
    assert.deepEqual(currentTuiRoute(unscoped.store.getState()), {
        page: "audit",
        scope: "unscoped",
        view: "context",
    });
    assert.equal(topTuiOverlay(unscoped.store.getState().interaction.overlays), undefined);

    const call = createHarness();
    enableContextMessageMcp(call);
    call.store.setSelectedPage("audit");
    call.store.replaceRoute({
        callId: "call-1",
        page: "audit",
        scope: "unscoped",
        view: "call",
    });
    await call.press("m");
    assert.deepEqual(currentTuiRoute(call.store.getState()), {
        callId: "call-1",
        page: "audit",
        scope: "unscoped",
        view: "call",
    });
    assert.equal(topTuiOverlay(call.store.getState().interaction.overlays), undefined);

    const context = createHarness();
    enableContextMessageMcp(context);
    enterAuditContext(context, "ctx-alpha");
    await context.press("m");
    assert.deepEqual(currentTuiRoute(context.store.getState()), {
        ctxId: "ctx-alpha",
        page: "audit",
        scope: "context",
        view: "conversation",
    } as never);
    assert.equal(topTuiOverlay(context.store.getState().interaction.overlays), undefined);
    await context.dispatch({ type: "ui.cancel" });
    assert.deepEqual(currentTuiRoute(context.store.getState()), {
        ctxId: "ctx-alpha",
        page: "audit",
        scope: "context",
        view: "context",
    });
});

test("Comment conversation shows exact history and keeps the route open after send", async () => {
    const sent: string[] = [];
    const harness = createHarness({
        onContextMessage: async (instance, ctxId, text) => {
            sent.push(text);
            const pending: ContextMessageRecord = {
                createdAt: "2026-08-02T00:03:00.000Z",
                ctxId,
                id: "message-new",
                instance,
                status: "pending",
                text,
            };
            harness.store.replaceContextMessages(instance, [pending]);
        },
    });
    enableContextMessageMcp(harness);
    harness.store.replaceContextMessages("alpha", [
        {
            createdAt: "2026-08-02T00:02:00.000Z",
            ctxId: "ctx-alpha",
            error: "delivery failed",
            failedAt: "2026-08-02T00:02:30.000Z",
            id: "message-failed",
            instance: "alpha",
            status: "failed",
            text: "second comment",
        },
        {
            createdAt: "2026-08-02T00:01:00.000Z",
            ctxId: "ctx-alpha",
            deliveredAt: "2026-08-02T00:01:30.000Z",
            id: "message-delivered",
            instance: "alpha",
            status: "delivered",
            text: "first comment",
        },
        {
            createdAt: "2026-08-02T00:00:00.000Z",
            ctxId: "ctx-other",
            id: "message-other",
            instance: "alpha",
            status: "pending",
            text: "other context comment",
        },
    ]);
    enterAuditContext(harness, "ctx-alpha");
    await harness.press("m");

    let text = conversationScreenText(harness);
    assert.equal(text.includes("other context comment"), false);
    assert.ok(text.indexOf("first comment") < text.indexOf("second comment"));
    assert.match(text, /delivered/i);
    assert.match(text, /failed/i);
    assert.match(text, /delivery failed/i);
    assert.match(text, /2026-08-02T00:01:00.000Z/);

    await harness.dispatch({ type: "contextConversation.edit" });
    await harness.press("new guidance");
    await harness.press("", { return: true });
    assert.deepEqual(sent, ["new guidance"]);
    assert.deepEqual(currentTuiRoute(harness.store.getState()), {
        ctxId: "ctx-alpha",
        page: "audit",
        scope: "context",
        view: "conversation",
    } as never);
    text = conversationScreenText(harness);
    assert.match(text, /new guidance/);
    assert.match(text, /pending/i);

    await harness.press("", { return: true });
    assert.deepEqual(sent, ["new guidance"], "successful send must clear the draft");
});

test("Todo uses a dedicated instance-scoped page and does not appear in Instances boxes", async () => {
    const harness = createHarness();
    assert.equal(
        selectMainScreenModel(harness.store.getState()).boxes.some((box) =>
            box.id.startsWith("todo-"),
        ),
        false,
    );

    harness.store.setSelectedPage("todo");
    assert.deepEqual(
        selectMainScreenModel(harness.store.getState()).boxes.map(
            (box) => box.id,
        ),
        [
            "todo-task:task-1",
            "todo-item:inspect",
            "todo-item:implement",
            "todo-item:verify",
        ],
    );
    for (const box of selectMainScreenModel(harness.store.getState()).boxes) {
        assert.notEqual(box.primaryAction, undefined);
    }
    await openPrimaryRoute(harness, "todo-task:task-1");
    assert.deepEqual(currentTuiRoute(harness.store.getState()), {
        page: "todo",
        todoId: "task-1",
        view: "detail",
    });
    assert.deepEqual(
        selectMainScreenModel(harness.store.getState()).boxes.map(
            (box) => box.id,
        ),
        [
            "todo-summary:task-1",
            "todo-item:inspect",
            "todo-item:implement",
            "todo-item:verify",
        ],
    );
});
test("shifted number shortcuts switch the selected instance without coupling Instances box focus", async () => {
    const harness = createHarness();

    await harness.press("@", { shift: true });
    assert.equal(harness.store.getState().ui.selectedInstance, "beta");
    assert.equal(
        harness.store.getState().interaction.sidebarCursor?.kind,
        "instance",
    );
    assert.equal(
        harness.store.getState().interaction.sidebarCursor?.id,
        "beta",
    );

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
    let alpha = selectMainScreenModel(harness.store.getState()).boxes.find(
        (box) => box.id === "instance:alpha",
    )!;
    assert.notEqual(
        alpha.expandedLines.find((line) => line.text === "[ Restart ]")
            ?.disabled,
        true,
    );
    assert.notEqual(
        alpha.expandedLines.find((line) => line.text === "[ Stop ]")?.disabled,
        true,
    );

    harness.store.upsertCommand({
        commandId: "busy-alpha",
        sourcePanel: "instances",
        startedAt: "2026-07-10T00:00:00.000Z",
        status: "running",
        targetInstance: "alpha",
        title: "Restart Worker: alpha",
    });
    alpha = selectMainScreenModel(harness.store.getState()).boxes.find(
        (box) => box.id === "instance:alpha",
    )!;
    assert.equal(
        alpha.expandedLines.find((line) => line.text === "[ Restart ]")
            ?.disabled,
        true,
    );
    assert.equal(
        alpha.expandedLines.find((line) => line.text === "[ Stop ]")?.disabled,
        true,
    );

    harness.store.setSelectedDetailLine(
        "instances:alpha:instance",
        "instance:alpha:button:restart",
    );
    await harness.dispatch({ type: "focus.activate" });
    assert.deepEqual(harness.instanceActions(), []);
});

test("mouse hit regions follow the rendered sidebar, boxes, and overlays", () => {
    const harness = createHarness();
    const viewport = { columns: 120, rows: 40 };
    const initialRegions = buildTuiHitRegions(
        harness.store.getState(),
        viewport,
    );
    const pageRegion = initialRegions.find(
        (region) =>
            region.target.kind === "page" && region.target.id === "config",
    )!;
    const instanceRegion = initialRegions.find(
        (region) =>
            region.target.kind === "instance" && region.target.id === "alpha",
    )!;
    const boxRegion = initialRegions.find(
        (region) =>
            region.target.kind === "boxTitle" &&
            region.target.boxId === "create-instance",
    )!;

    assert.deepEqual(
        hitTargetAt(initialRegions, pageRegion.x, pageRegion.y),
        pageRegion.target,
    );
    assert.deepEqual(
        hitTargetAt(initialRegions, instanceRegion.x, instanceRegion.y),
        instanceRegion.target,
    );
    assert.deepEqual(
        hitTargetAt(initialRegions, boxRegion.x, boxRegion.y),
        boxRegion.target,
    );

    harness.store.setPanelError(
        "instances:alpha",
        createError({
            code: "control.failed",
            message: "rendered error",
            retryable: false,
        }),
    );
    const erroredRegions = buildTuiHitRegions(
        harness.store.getState(),
        viewport,
    );
    const shiftedBoxRegion = erroredRegions.find(
        (region) =>
            region.target.kind === "boxTitle" &&
            region.target.boxId === "create-instance",
    )!;
    assert.equal(shiftedBoxRegion.y, boxRegion.y + 3);
});

test("space expands a box without blocking main box navigation", async () => {
    const harness = createHarness();
    harness.store.setFocusScope("mainBoxes");
    harness.store.setMainFocusId("instance:alpha");

    await harness.press(" ");
    assert.equal(
        selectMainScreenModel(harness.store.getState()).boxes.find(
            (box) => box.id === "instance:alpha",
        )?.expanded,
        true,
    );
    assert.match(selectFooterText(harness.store.getState()), /space expand/u);

    await harness.press(" ");
    await harness.press("", { downArrow: true });
    assert.equal(harness.store.getState().ui.mainFocusId, "instance:beta");
});
test("box rendering wraps Unicode text by terminal display width", () => {
    assert.deepEqual(wrapTerminalText("配置 😀 long-value", 8), [
        "配置 😀",
        "long-val",
        "ue",
    ]);

    const lines = renderExpandableBoxLines(
        {
            collapsedLines: [{ text: "01234567890123456789012345" }],
            enterable: false,
            expandable: true,
            expanded: false,
            expandedKey: "test",
            expandedLines: [],
            focused: false,
            id: "test",
            status: "normal",
            title: "测试",
        },
        24,
    );

    assert.equal(lines.length, 4);
    assert.equal(lines[1]?.text, "│ 012345678901234567890123 │");
    assert.equal(lines[2]?.text, "│ 45                       │");
});

test("only real editable fields render with the shared underline affordance", () => {
    const editable = fieldLine("workspace", "Workspace", "/workspace");
    const lines = renderExpandableBoxLines(
        {
            collapsedLines: [{ text: "summary" }],
            enterable: false,
            expandable: true,
            expanded: true,
            expandedKey: "editor",
            expandedLines: [
                editable,
                { id: "runtime", text: "Runtime            running" },
            ],
            focused: true,
            id: "editor",
            selectedDetailLineId: "field:workspace",
            status: "normal",
            title: "Configuration",
        },
        80,
    );

    const editableLine = lines.find((line) =>
        line.key.includes("field:workspace"),
    );
    const readOnlyLine = lines.find((line) => line.key.includes("runtime"));
    assert.equal(
        editableLine?.segments?.some(
            (segment) => segment.text.includes("/workspace") && segment.underline === true,
        ),
        true,
    );
    assert.equal(
        editableLine?.segments?.some(
            (segment) => segment.text.includes("Workspace") && segment.underline === true,
        ),
        false,
    );
    assert.equal(readOnlyLine?.segments?.some((segment) => segment.underline === true) ?? false, false);
});

test("choice fields underline the whole selector and blink it while editing", () => {
    const choice = choiceLine("enabled", "enabled", true);
    const base = {
        collapsedLines: [{ text: "summary" }] as const,
        enterable: false,
        expandable: true,
        expanded: true,
        expandedKey: "choice-editor",
        focused: true,
        id: "choice-editor",
        selectedDetailLineId: "field:enabled",
        status: "normal" as const,
        title: "Configuration",
    };

    const browsing = renderExpandableBoxLines(
        { ...base, expandedLines: [choice] },
        80,
    ).find((line) => line.key.includes("field:enabled"));
    assert.equal(
        browsing?.segments?.some(
            (segment) => segment.text === "<true>" && segment.underline === true,
        ),
        true,
    );

    const visible = renderExpandableBoxLines(
        {
            ...base,
            expandedLines: [{ ...choice, editing: true, cursorVisible: true }],
        },
        80,
    ).find((line) => line.key.includes("field:enabled"));
    assert.deepEqual(
        visible?.segments?.filter((segment) => segment.underline === true).map((segment) => segment.text),
        ["<true>"],
    );

    const hidden = renderExpandableBoxLines(
        {
            ...base,
            expandedLines: [{ ...choice, editing: true, cursorVisible: false }],
        },
        80,
    ).find((line) => line.key.includes("field:enabled"));
    assert.equal(hidden?.segments?.some((segment) => segment.underline === true) ?? false, false);
});

test("box borders encode result status and retain severity while focused", () => {
    const base = {
        collapsedLines: [{ text: "summary" }] as const,
        enterable: false,
        expandable: true,
        expanded: false,
        expandedKey: "test",
        expandedLines: [],
        id: "test",
        title: "Result",
    };

    assert.equal(
        renderExpandableBoxLines(
            { ...base, focused: false, status: "ready" },
            24,
        )[0]?.color,
        "green",
    );
    assert.equal(
        renderExpandableBoxLines(
            { ...base, focused: false, status: "failed" },
            24,
        )[0]?.color,
        "red",
    );
    const focused = renderExpandableBoxLines(
        { ...base, focused: true, severity: "danger", status: "pending" },
        24,
    )[0]!;
    assert.equal(focused.backgroundColor, "magenta");
    assert.equal(focused.color, "white");
    assert.match(focused.text, /Result \[… pending\]/u);
    assert.equal(
        renderExpandableBoxLines(
            { ...base, focused: true, severity: "danger", status: "pending" },
            24,
        )[1]?.backgroundColor,
        "magenta",
    );
});

test("narrow terminals use compact navigation and reject unsupported sizes", () => {
    assert.equal(tuiLayoutMetrics(120).mode, "full");
    assert.equal(tuiLayoutMetrics(80).mode, "compact");
    assert.equal(mainInnerWidth(80), 76);
    assert.equal(isTerminalSizeSupported(80, 20), true);
    assert.equal(isTerminalSizeSupported(59, 20), false);
    assert.equal(isTerminalSizeSupported(80, 13), false);

    const harness = createHarness();
    assert.deepEqual(
        buildTuiHitRegions(harness.store.getState(), { columns: 59, rows: 20 }),
        [],
    );
});

test("main box focus activates the main panel from the sidebar", () => {
    const harness = createHarness();

    const moved = harness.focusManager.setFocus({
        id: "instance:alpha",
        kind: "box",
    });

    assert.equal(moved, true);
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");
    assert.equal(harness.store.getState().ui.mainFocusId, "instance:alpha");
});

test("left and right arrows switch between the sidebar and main panel", async () => {
    const harness = createHarness();

    await harness.press("", { rightArrow: true });
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");
    assert.match(selectFooterText(harness.store.getState()), /← sidebar/u);

    await harness.press("", { leftArrow: true });
    assert.equal(
        harness.store.getState().interaction.focusScope,
        "sidebarPages",
    );
    assert.match(selectFooterText(harness.store.getState()), /→ main/u);
});

test("Create flow uses a wizard with focusable fields and command buttons", async () => {
    const harness = createHarness();

    await openCreateWizard(harness);

    assert.equal(harness.store.getState().interaction.focusScope, "wizard");
    assert.equal(harness.store.getState().ui.mainFocusId, "create-wizard");
    const wizard = selectMainScreenModel(harness.store.getState()).boxes[0];
    assert.equal(wizard?.title, "Create");
    assert.equal(
        harness.store.getState().interaction.selectedDetailLineIds[
            "instances:all:create-wizard"
        ],
        wizard?.expandedLines[2]?.id,
    );
    await harness.press("", { upArrow: true });
    assert.equal(
        harness.store.getState().interaction.selectedDetailLineIds[
            "instances:all:create-wizard"
        ],
        wizard?.expandedLines[1]?.id,
    );
    await harness.press("", { upArrow: true });
    assert.equal(
        harness.store.getState().interaction.selectedDetailLineIds[
            "instances:all:create-wizard"
        ],
        wizard?.expandedLines[0]?.id,
    );
    assert.equal(
        wizard?.expandedLines.some((line) => line.id?.includes(":field:name")),
        true,
    );
    assert.equal(
        wizard?.expandedLines.some((line) =>
            line.id?.includes(":button:validate"),
        ),
        true,
    );
    assert.equal(
        wizard?.expandedLines.some((line) =>
            line.id?.includes(":button:create"),
        ),
        true,
    );
    assert.equal(
        wizard?.expandedLines.some((line) =>
            line.id?.includes(":button:cancel"),
        ),
        true,
    );
});

test("create wizard provider and container choices replace incompatible fields", async () => {
    const harness = createHarness();
    await openCreateWizard(harness);
    const expandedKey = "instances:all:create-wizard";
    harness.store.setFormDraft("create", {
        approvalPolicy: { mode: "disabled" },
        container: { containerName: "stale", image: "stale", mode: "existingImage" },
        enabled: true,
        mcp: { auth: "none", enabled: true, tools: { capabilities: ["read"], groups: ["file"] } },
        name: "choice-test",
        provider: "local",
        security: { mode: "disabled" },
        ssh: { command: "stale" },
        workspace: "/workspace"
    }, true);
    harness.store.setSelectedDetailLine(expandedKey, "create-wizard:field:provider");

    await harness.dispatch({ direction: "right", type: "editor.cursorMove" });
    let draft = harness.store.getState().ui.formDrafts.create as Record<string, JsonValue>;
    assert.equal(draft.provider, "ssh");
    assert.deepEqual(draft.ssh, { command: "" });
    assert.equal(draft.container, undefined);

    await harness.dispatch({ direction: "right", type: "editor.cursorMove" });
    draft = harness.store.getState().ui.formDrafts.create as Record<string, JsonValue>;
    assert.equal(draft.provider, "docker");
    assert.equal(draft.ssh, undefined);
    assert.deepEqual(draft.container, {
        containerName: "devshell-choice-test",
        image: "",
        mode: "preset",
        preset: ""
    });

    harness.store.setEditor({ ...harness.store.getState().interaction.editor!, step: 2 });
    harness.store.setSelectedDetailLine(expandedKey, "create-wizard:field:container.mode");
    await harness.dispatch({ direction: "right", type: "editor.cursorMove" });
    draft = harness.store.getState().ui.formDrafts.create as Record<string, JsonValue>;
    assert.deepEqual(draft.container, {
        build: { context: "", tag: "devshell-choice-test:latest" },
        containerName: "devshell-choice-test",
        mode: "dockerfile"
    });
});

test("wizard validation keeps the draft and reports the control error", async () => {
    const harness = createHarness({
        onValidateInstanceCreateDraft: async () => {
            throw new Error("name is required");
        },
    });

    await openCreateWizard(harness);
    harness.store.setFormDraft("create", {
        enabled: true,
        mcp: { enabled: true },
        name: "alpha",
        provider: "reverse",
        security: { mode: "disabled" },
    });
    await harness.dispatch({ type: "editor.validate" });

    assert.equal(harness.store.getState().interaction.focusScope, "wizard");
    assert.equal(
        harness.store.getState().interaction.editor?.error,
        "name is required",
    );
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

    assert.equal(
        (harness.store.getState().ui.formDrafts.create as { name?: unknown })
            .name,
        "zcd",
    );
    const wizard = selectMainScreenModel(harness.store.getState()).boxes[0];
    const selectedLine = renderExpandableBoxLines(wizard!, 80).find((line) =>
        line.key.includes(wizard?.selectedDetailLineId ?? "missing"),
    );
    const cursors = selectedLine?.segments?.filter((segment) => segment.underline === true) ?? [];
    assert.equal(cursors.length, 1);
    assert.equal(cursors[0]?.text.length, 1);
    assert.equal(wizard?.expandedLines.some((line) => line.text.includes("█")), false);
});

test("wizard normalizes friendly container mode labels before control validation", async () => {
    let validatedMode: unknown;
    const harness = createHarness({
        onValidateInstanceCreateDraft: async (draft) => {
            validatedMode = draft.container?.mode;
            return instanceCreateSummary(draft);
        },
    });

    await openCreateWizard(harness);
    harness.store.setFormDraft("create", {
        container: {
            containerName: "alpha-container",
            mode: "Existing stopped container",
        },
        name: "alpha",
        provider: "docker",
    });
    await harness.dispatch({ type: "editor.validate" });

    assert.equal(validatedMode, "existingStoppedContainer");
    assert.equal(
        (
            harness.store.getState().ui.formDrafts.create as {
                container?: { mode?: unknown };
            }
        ).container?.mode,
        "existingStoppedContainer",
    );
});

test("config validation errors render in the active field box", async () => {
    const harness = createHarness({
        onValidateConfigDraft: async () => {
            throw new Error("workspace must be an absolute path");
        },
    });

    await harness.press("2");
    await harness.press("", { tab: true });
    await harness.press(" ");
    await harness.press("", { downArrow: true });
    await harness.press("", { return: true });
    await harness.press("s", { ctrl: true });

    const configuration = selectMainScreenModel(
        harness.store.getState(),
    ).boxes.find((box) => box.id === "configuration");
    assert.equal(
        configuration?.expandedLines.some(
            (line) => line.text === "error: workspace must be an absolute path",
        ),
        true,
    );
    assert.equal(configuration?.status, "failed");
});

test("config choices use angle selectors and replace incompatible provider fields", async () => {
    const harness = createHarness();
    harness.store.setSelectedPage("config");
    openEditorForBox(harness, "config", "configuration");
    harness.store.setFormDraft("config:alpha", {
        approvalPolicy: { mode: "ask" },
        enabled: true,
        mcp: { enabled: true, path: "/alpha/mcp" },
        name: "alpha",
        provider: "ssh",
        security: { mode: "disabled" },
        ssh: { command: "ssh alpha.example" },
        workspace: "/workspace/alpha",
    });

    const general = expandBox(harness, "configuration");
    const security = expandBox(harness, "security");
    assert.equal(
        general.expandedLines.some((line) => line.editableValue?.value === "ssh"),
        true,
    );
    assert.equal(
        security.expandedLines.some((line) => line.editableValue?.value === "disabled"),
        true,
    );
    assert.equal(
        security.expandedLines.some((line) => line.editableValue?.value === "ask"),
        true,
    );

    const provider = general.expandedLines.find((line) =>
        line.editableValue?.value === "ssh",
    );
    assert.ok(provider?.id);
    harness.store.setMainFocusId(general.id);
    harness.store.setFocusScope("form");
    harness.store.setSelectedDetailLine(general.expandedKey, provider.id);
    await harness.press("", { leftArrow: true });
    const switched = harness.store.getState().ui.formDrafts["config:alpha"] as {
        container?: unknown;
        dockerBinary?: unknown;
        provider?: unknown;
        ssh?: { command?: unknown };
    };
    assert.equal(switched.provider, "local");
    assert.equal(switched.container, undefined);
    assert.equal(switched.dockerBinary, undefined);
    assert.equal(switched.ssh, undefined);
});
test("config exposes reload, save-only, and save-and-restart semantics", () => {
    const harness = createHarness();
    harness.store.setSelectedPage("config");
    openEditorForBox(harness, "config", "configuration");

    let actions = expandBox(harness, "configuration-actions");
    assert.notEqual(actions.status, "failed");
    assert.equal(
        actions.expandedLines.some((line) => line.text === "[ Reload ]"),
        true,
    );
    assert.equal(
        actions.expandedLines.some((line) => line.text === "[ Save Only ]"),
        true,
    );
    assert.equal(
        actions.expandedLines.some(
            (line) => line.text === "[ Save & Restart ]",
        ),
        true,
    );

    harness.store.setFormDraft("config:alpha", {
        ...(harness.store.getState().ui.formDrafts["config:alpha"] as Record<
            string,
            unknown
        >),
        provider: "ssh",
    });
    actions = expandBox(harness, "configuration-actions");
    assert.equal(actions.status, "warning");
    assert.equal(
        actions.expandedLines.find((line) => line.text === "[ Save Only ]")
            ?.disabled,
        true,
    );
    assert.equal(
        actions.expandedLines.some(
            (line) => line.text === "Apply mode          restart required",
        ),
        true,
    );
});
test("failed Save & Restart restores a previously running instance", async () => {
    const harness = createHarness({
        onConfigUpdate: async () => {
            throw new Error("configuration transaction failed");
        },
    });
    harness.store.setSelectedPage("config");
    openEditorForBox(harness, "config", "configuration");
    harness.store.setFormDraft("config:alpha", {
        ...(harness.store.getState().ui.formDrafts["config:alpha"] as Record<string, JsonValue>),
        provider: "ssh",
        ssh: { command: "ssh alpha" },
    });

    const actions = expandBox(harness, "configuration-actions");
    harness.store.setMainFocusId(actions.id);
    harness.store.setFocusScope("form");
    harness.store.setSelectedDetailLine(
        actions.expandedKey,
        "configuration-actions:button:save-restart",
    );
    await harness.dispatch({ type: "focus.activate" });

    assert.deepEqual(harness.instanceActions(), [
        { action: "stop", instance: "alpha" },
        { action: "start", instance: "alpha" },
    ]);
    assert.match(harness.store.getState().interaction.editor?.error ?? "", /configuration transaction failed/u);
    assert.equal(harness.store.getState().ui.dirtyForms["config:alpha"], true);
});

test("config separates MCP tool access and requires restart when it changes", () => {
    const harness = createHarness();
    harness.store.setSelectedPage("config");
    openEditorForBox(harness, "config", "configuration");
    harness.store.setFormDraft("config:alpha", {
        ...(harness.store.getState().ui.formDrafts["config:alpha"] as Record<
            string,
            unknown
        >),
        mcp: {
            enabled: true,
            path: "/alpha/mcp",
            tools: { capabilities: ["read"], groups: ["file", "context"] },
        },
    });

    const mcpTools = expandBox(harness, "mcp-tools");
    const actions = expandBox(harness, "configuration-actions");
    assert.equal(mcpTools.title, "MCP Tool Access");
    assert.equal(
        mcpTools.expandedLines.some((line) => line.text.includes("context")),
        true,
    );
    assert.equal(
        mcpTools.expandedLines.some((line) => line.text.includes("read")),
        true,
    );
    assert.equal(
        actions.expandedLines.some(
            (line) => line.text === "Apply mode          restart required",
        ),
        true,
    );
});
test("config exposes container and tool scheduler settings", () => {
    const harness = createHarness();
    harness.store.setSelectedPage("config");
    harness.store.setFormDraft("config:alpha", {
        container: {
            build: {
                context: "/workspace/alpha",
                dockerfile: "Dockerfile.dev",
            },
            env: { API_TOKEN: "secret" },
            mode: "dockerfile",
            mounts: [{ source: "/host", target: "/container" }],
        },
        dockerBinary: "/usr/bin/docker",
        enabled: true,
        logs: { eventBufferSize: 100, maxBytes: 67_108_864, retentionDays: 7 },
        mcp: {
            enabled: true,
            path: "/alpha/mcp",
            tools: { capabilities: ["read"], groups: ["file"] },
        },
        name: "alpha",
        provider: "docker",
        security: { mode: "disabled" },
        tools: {
            scheduler: { maxRunning: 2, queueDepth: 8, queueTimeoutMs: 3000 },
        },
        workspace: "/workspace/alpha",
    });

    const provider = expandBox(harness, "provider");
    const runtime = expandBox(harness, "tool-runtime");
    const logs = expandBox(harness, "logs");
    assert.equal(
        provider.expandedLines.some((line) =>
            line.text.includes("Dockerfile.dev"),
        ),
        true,
    );
    assert.equal(
        provider.expandedLines.some((line) =>
            line.text.includes("/workspace/alpha"),
        ),
        true,
    );
    assert.equal(
        provider.expandedLines.some((line) => line.editableValue?.value === "dockerfile"),
        true,
    );
    assert.equal(
        provider.expandedLines.some((line) => line.text.includes("/usr/bin/docker")),
        true,
    );
    assert.equal(
        provider.expandedLines.some((line) => line.text.includes("podmanBinary")),
        false,
    );
    assert.equal(
        provider.expandedLines.some((line) => line.text.includes('[{"source":"/host","target":"/container"}]')),
        true,
    );
    assert.equal(
        provider.expandedLines.some((line) => line.text.includes("API_TOKEN=secret")),
        false,
    );
    const mcpTools = expandBox(harness, "mcp-tools");
    assert.equal(
        mcpTools.expandedLines.some((line) => line.id?.includes(":field:mcp.path")),
        false,
    );
    assert.equal(
        mcpTools.expandedLines.some((line) => line.text.includes("/alpha/mcp")),
        true,
    );
    assert.equal(
        runtime.expandedLines.some((line) => line.text.includes("3000")),
        true,
    );
    assert.equal(
        logs.expandedLines.some((line) => line.text.includes("67108864")),
        true,
    );
    assert.equal(
        logs.expandedLines.some((line) => line.text.includes("retentionDays")),
        true,
    );
});
test("audit truncates input and output previews while opening complete structured details", async () => {
    const harness = createHarness();
    const patch =
        "*** Begin Patch\n*** Update File: src/example.ts\n" +
        "-old\n+new\n".repeat(40) +
        "*** End Patch";
    const output = {
        complete: true,
        files: [{ path: "src/example.ts", diff: "+new\n".repeat(40) }],
    };
    harness.store.applyEvent({
        destination: asInstanceName("alpha"),
        id: "tool-queued-live-patch",
        name: "toolCall.queued",
        payload: {
            at: "2026-07-14T00:00:00.000Z",
            data: {
                callId: "live-patch",
                ctxId: "ctx-live-patch",
                input: { input: patch },
                inputSummary: JSON.stringify({ input: patch }),
                source: "mcp",
                startedAt: "2026-07-14T00:00:00.000Z",
                status: "queued",
                toolName: "file_edit",
            },
        },
        seq: 21,
    });
    harness.store.applyEvent({
        destination: asInstanceName("alpha"),
        id: "tool-completed-live-patch",
        name: "toolCall.completed",
        payload: {
            at: "2026-07-14T00:00:01.000Z",
            data: {
                callId: "live-patch",
                completedAt: "2026-07-14T00:00:01.000Z",
                output,
                source: "mcp",
                startedAt: "2026-07-14T00:00:00.000Z",
                status: "completed",
                toolName: "file_edit",
            },
        },
        seq: 22,
    });
    enterAuditContext(harness, "ctx-live-patch");
    const audit = expandBox(harness, "audit-call:live-patch");
    const inputLine = audit.expandedLines.find(
        (line) => line.id === "audit-call:live-patch:input",
    );
    const outputLine = audit.expandedLines.find(
        (line) => line.id === "audit-call:live-patch:output",
    );
    assert.ok(inputLine?.id && outputLine?.id);
    assert.equal(inputLine.text.length <= 96, true);
    assert.equal(outputLine.text.length <= 96, true);
    assert.equal(inputLine.text.endsWith("…"), true);
    assert.equal(outputLine.text.endsWith("…"), true);

    harness.store.setFocusScope("boxDetail");
    harness.store.setMainFocusId(audit.id);
    harness.store.setSelectedDetailLine(audit.expandedKey, inputLine.id);
    await harness.dispatch({ type: "focus.activate" });
    let overlay = topTuiOverlay(harness.store.getState().interaction.overlays);
    assert.equal(overlay?.kind, "text-detail");
    assert.equal(
        overlay?.kind === "text-detail" &&
            overlay.body.includes("*** Begin Patch"),
        true,
    );

    await harness.dispatch({ type: "textDetail.close" });
    harness.store.setSelectedDetailLine(audit.expandedKey, outputLine.id);
    await harness.dispatch({ type: "focus.activate" });
    overlay = topTuiOverlay(harness.store.getState().interaction.overlays);
    assert.equal(
        overlay?.kind === "text-detail" &&
            overlay.body.includes("complete: true"),
        true,
    );
    assert.equal(
        overlay?.kind === "text-detail" &&
            overlay.body.includes("src/example.ts"),
        true,
    );
});
test("artifact_viewImage audit output loads an image into the detail panel", async () => {
    const calls: Array<{ input: unknown; instance: string }> = [];
    const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const harness = createHarness({
        onArtifactViewImage: async (instance, input) => {
            calls.push({ input, instance });
            return {
                bytes: 68,
                content: png,
                encoding: "base64",
                mediaType: "image/png",
                name: "preview.png",
                source: { instance, path: "./preview.png", type: "file" },
            };
        },
    });
    harness.store.replaceToolCalls("alpha", [
        {
            callId: "image-call",
            completedAt: "2026-07-18T00:00:01.000Z",
            ctxId: "ctx-image",
            input: { path: "./preview.png" },
            inputSummary: '{"path":"./preview.png"}',
            instance: "alpha" as never,
            output: {
                bytes: 68,
                mediaType: "image/png",
                name: "preview.png",
                source: {
                    instance: "alpha",
                    path: "./preview.png",
                    type: "file",
                },
            },
            source: "mcp",
            startedAt: "2026-07-18T00:00:00.000Z",
            status: "completed",
            toolName: "artifact_viewImage",
        },
    ]);
    enterAuditContext(harness, "ctx-image");
    const audit = expandBox(harness, "audit-call:image-call");
    harness.store.setFocusScope("boxDetail");
    harness.store.setMainFocusId(audit.id);
    harness.store.setSelectedDetailLine(
        audit.expandedKey,
        "audit-call:image-call:output",
    );
    await harness.dispatch({ type: "focus.activate" });

    const overlay = topTuiOverlay(
        harness.store.getState().interaction.overlays,
    );
    assert.deepEqual(calls, [
        { input: { path: "./preview.png" }, instance: "alpha" },
    ]);
    assert.equal(overlay?.kind, "text-detail");
    assert.equal(
        overlay?.kind === "text-detail" ? overlay.image?.content : undefined,
        png,
    );
    assert.equal(
        overlay?.kind === "text-detail" ? overlay.image?.mediaType : undefined,
        "image/png",
    );
    assert.equal(
        overlay?.kind === "text-detail" && overlay.body.includes("preview.png"),
        true,
    );
});
test("audit renders legacy records without an input summary", () => {
    const harness = createHarness();
    harness.store.replaceToolCalls("alpha", [
        {
            callId: "legacy-call",
            instance: "alpha",
            source: "mcp",
            startedAt: "2026-07-14T00:00:00.000Z",
            status: "completed",
            toolName: "bash_run",
        } as never,
    ]);
    harness.store.replaceLogs("alpha", [
        {
            at: "2026-07-14T00:00:01.000Z",
            bytes: 14,
            callId: "legacy-call",
            ctxId: "ctx-legacy",
            instance: "alpha",
            message: "legacy output\n",
            preview: "legacy output\n",
            receivedAt: "2026-07-14T00:00:01.000Z",
            seq: 1,
            source: "mcp",
            stream: "stdout",
            tail: "legacy output\n",
            toolName: "bash_run",
        },
    ]);
    enterAuditUnscoped(harness);
    const audit = expandBox(harness, "audit-call:legacy-call");
    assert.equal(
        audit.expandedLines.some(
            (line) => line.id === "audit-call:legacy-call:input" && line.text.trimEnd().endsWith("-"),
        ),
        true,
    );
    assert.equal(
        audit.expandedLines.some((line) => line.text.includes("legacy output")),
        true,
    );
});
test("connector discard confirms and clears its per-instance MCP draft", async () => {
    const harness = createHarness();
    enterConnectionsRoute(harness, "connector");
    harness.store.setFormDraft(
        "connector:alpha",
        {
            enabled: true,
            listenHost: "0.0.0.0",
            listenPort: 3210,
        },
        true,
    );
    harness.store.setEditor({
        editing: false,
        key: "connector:alpha",
        kind: "connector",
    });

    await harness.dispatch({ type: "editor.discard" });
    const overlay = topTuiOverlay(
        harness.store.getState().interaction.overlays,
    );
    assert.equal(overlay?.kind, "confirmation");
    assert.equal(
        overlay?.kind === "confirmation" ? overlay.selectedAction : undefined,
        "cancel",
    );
    await harness.dispatch({ button: "confirm", type: "confirm.focus" });
    await harness.dispatch({ type: "confirm.accept" });

    assert.equal(harness.store.getState().interaction.editor, undefined);
    assert.equal(
        harness.store.getState().ui.formDrafts["connector:alpha"],
        undefined,
    );
});
test("instances collection does not append a start command box", () => {
    const harness = createHarness();
    harness.store.upsertCommand({
        commandId: "start-alpha",
        sourcePanel: "instances",
        startedAt: "2026-07-10T00:00:00.000Z",
        status: "succeeded",
        targetInstance: "alpha",
        title: "Start Worker: alpha",
    });

    assert.deepEqual(
        selectMainScreenModel(harness.store.getState()).boxes.map(
            (box) => box.id,
        ),
        ["create-instance", "instance:alpha", "instance:beta"],
    );
});

test("expanded instance entries expose only compact lifecycle controls", async () => {
    const harness = createHarness();

    await harness.press("", { tab: true });
    await harness.press("", { downArrow: true });
    await harness.press(" ");

    const entry = selectMainScreenModel(harness.store.getState()).boxes.find(
        (box) => box.id === "instance:alpha",
    );
    const lines = entry?.expandedLines.map((line) => line.text) ?? [];
    assert.equal(lines.includes("[ Attach Shell ]"), true);
    assert.equal(lines.includes("[ Restart ]"), true);
    assert.equal(lines.includes("[ Stop ]"), true);
    assert.equal(lines.includes("[ Delete ]"), true);
    assert.equal(
        lines.some((line) => line.includes("enabled") && line.includes("yes")),
        true,
    );
    assert.equal(
        lines.some((line) => line.includes("mcpPath")),
        false,
    );
    assert.equal(
        lines.some((line) => line.includes("lastError")),
        false,
    );
    assert.equal(lines.includes("[ Open Config ]"), false);
    assert.equal(lines.includes("[ Open Connector ]"), false);
    assert.equal(entry?.collapsedLines[0]?.text.includes("daemon="), false);
    assert.equal(entry?.collapsedLines[0]?.text.includes("rpc="), false);
    assert.equal(entry?.collapsedLines[0]?.text.includes("ready="), false);
});

test("Prompt 3 detail line selection clamps to a valid line after data replacement", () => {
    const harness = createHarness();
    harness.store.replaceLogs("alpha", [
        {
            at: "2026-07-31T00:00:01.000Z",
            ctxId: "ctx-alpha",
            instance: "alpha",
            message: "one",
            receivedAt: "2026-07-31T00:00:01.000Z",
            seq: 1,
            stream: "stdout",
        },
        {
            at: "2026-07-31T00:00:02.000Z",
            ctxId: "ctx-alpha",
            instance: "alpha",
            message: "two",
            receivedAt: "2026-07-31T00:00:02.000Z",
            seq: 2,
            stream: "stdout",
        },
    ]);
    enterLogContext(harness, "ctx-alpha");
    let logs = expandBox(harness, "logs");
    harness.store.setMainFocusId(logs.id);
    harness.store.setSelectedDetailLine(logs.expandedKey, "logs:log:2");
    harness.store.replaceLogs("alpha", [
        {
            at: "2026-07-31T00:00:01.000Z",
            ctxId: "ctx-alpha",
            instance: "alpha",
            message: "one",
            receivedAt: "2026-07-31T00:00:01.000Z",
            seq: 1,
            stream: "stdout",
        },
    ]);
    harness.focusManager.syncPanel(
        harness.store.getState().ui.selectedPage,
        harness.store.getState().interaction.focusScope,
    );
    logs = selectMainScreenModel(harness.store.getState()).boxes.find(
        (box) => box.id === "logs",
    )!;
    assert.equal(logs.selectedDetailLineId, "logs:log:1");
});
test("connector editor presents unavailable endpoints and control runtime limits as user states", () => {
    const harness = createHarness();
    enterConnectionsRoute(harness, "connector");
    const connector = selectMainScreenModel(harness.store.getState());
    assert.deepEqual(
        connector.boxes.map((box) => box.title),
        [
            "[Instance] MCP Endpoint",
            "[Global] Public Base URL",
            "[Global] Web UI",
            "[Instance] Auth",
            "Page Actions",
            "Configured Endpoint",
            "Configuration Validation",
        ],
    );
    const endpoint = expandBox(harness, "mcp-endpoint");
    assert.equal(
        endpoint.expandedLines.some(
            (line) => line.text === "MCP runtime        stopped",
        ),
        true,
    );
    assert.deepEqual(
        connector.boxes
            .find((box) => box.id === "endpoint-preview")
            ?.collapsedLines.map((line) => line.text),
        ["endpoint=unavailable", "reason=missing publicBaseUrl"],
    );

    harness.store.setConfigView({
        instances: [
            {
                mcp: { auth: "none", enabled: true, path: "/alpha/custom-mcp" },
                name: "alpha",
                provider: "local",
            },
        ],
        mcp: {
            enabled: true,
            listenHost: "127.0.0.1",
            listenPort: 3210,
            publicBaseUrl: "https://example.test/tunnel",
        },
    });
    assert.deepEqual(
        selectMainScreenModel(harness.store.getState())
            .boxes.find((box) => box.id === "endpoint-preview")
            ?.collapsedLines.map((line) => line.text),
        ["endpoint=https://example.test/tunnel/alpha/custom-mcp"],
    );
});
test("connector page actions send all affected scopes in one configuration transaction", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const harness = createHarness({
        onConfigUpdate: async (value) => {
            updates.push(value);
            return {};
        },
    });
    enterConnectionsRoute(harness, "connector");
    harness.store.setFormDraft(
        "connector",
        {
            enabled: true,
            listenHost: "127.0.0.1",
            listenPort: 3210,
        },
        true,
    );
    harness.store.setFormDraft("web", {
        auth: "none", enabled: true, listenHost: "127.0.0.1", listenPort: 3211, publicBaseUrl: "127.0.0.1"
    }, true);
    harness.store.setEditor({
        editing: false,
        key: "connector",
        kind: "connector",
    });
    const actions = expandBox(harness, "connector-actions");
    assert.equal(
        actions.expandedLines.some(
            (line) => line.text === "Affected scopes    mcp + web",
        ),
        true,
    );
    harness.store.setMainFocusId(actions.id);
    harness.store.setFocusScope("boxDetail");
    harness.store.setSelectedDetailLine(
        actions.expandedKey,
        "connector-actions:button:save",
    );
    await harness.dispatch({ type: "focus.activate" });
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.instance, undefined);
    assert.deepEqual(updates[0]?.mcp, {
        enabled: true,
        listenHost: "127.0.0.1",
        listenPort: 3210,
        publicBaseUrl: undefined,
    });
    assert.deepEqual(updates[0]?.web, {
        auth: "none",
        enabled: true,
        listenHost: "127.0.0.1",
        listenPort: 3211,
        publicBaseUrl: "127.0.0.1",
    });
});
test("long detail lines open a wrapped full-text viewer", async () => {
    const harness = createHarness();
    harness.store.replaceOAuthApprovals([
        {
            approvalId: "oauth-long",
            clientId: "client-long",
            clientName: "Long Client",
            createdAt: "2026-07-10T00:00:00.000Z",
            expiresAt: "2026-07-10T00:05:00.000Z",
            kind: "authorization",
            redirectUris: [
                "https://example.test/callback/with/a/very/long/path/that/does/not/fit/in/a/single/terminal/line",
            ],
            requestedResources: [],
            requestedScopes: ["mcp"],
            status: "approved",
        },
    ]);
    enterConnectionsRoute(harness, "oauth");
    const approval = expandBox(harness, "oauth-approval-oauth-long");
    const redirect = approval.expandedLines.find((line) =>
        line.text.startsWith("redirectUris "),
    );
    assert.ok(redirect?.id);
    harness.store.setMainFocusId(approval.id);
    harness.store.setFocusScope("boxDetail");
    harness.store.setSelectedDetailLine(approval.expandedKey, redirect.id);
    await harness.dispatch({ type: "focus.activate" });
    let overlay = topTuiOverlay(harness.store.getState().interaction.overlays);
    assert.equal(overlay?.kind, "text-detail");
    assert.equal(
        overlay?.kind === "text-detail" &&
            /very\/long\/path/u.test(overlay.body),
        true,
    );
    await harness.press("", { return: true });
    overlay = topTuiOverlay(harness.store.getState().interaction.overlays);
    assert.equal(overlay, undefined);
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
            status: "pending",
        },
    ]);
    enterConnectionsRoute(harness, "oauth");
    const approval = expandBox(harness, "oauth-approval-oauth-1");
    assert.equal(approval.title, "OAuth registration approval");
    harness.store.setMainFocusId(approval.id);
    harness.store.setFocusScope("boxDetail");
    harness.store.setSelectedDetailLine(
        approval.expandedKey,
        "oauth-approval-oauth-1:oauth.approve:oauth-1",
    );
    await harness.dispatch({ type: "focus.activate" });
    const overlay = topTuiOverlay(
        harness.store.getState().interaction.overlays,
    );
    assert.equal(
        overlay?.kind === "confirmation" ? overlay.title : undefined,
        "Confirm OAuth Approval",
    );
    await harness.dispatch({ button: "confirm", type: "confirm.focus" });
    await harness.dispatch({ type: "confirm.accept" });
    assert.deepEqual(harness.oauthApprovalDecisions(), [
        { approvalId: "oauth-1", decision: "approve" },
    ]);
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
            status: "approved",
        },
    ]);
    enterConnectionsRoute(harness, "oauth");
    harness.store.setFocusScope("mainBoxes");
    harness.store.setMainFocusId("oauth-approval-oauth-completed");
    await harness.press(" ");
    const approval = selectMainScreenModel(harness.store.getState()).boxes.find(
        (box) => box.id === "oauth-approval-oauth-completed",
    )!;
    assert.equal(
        approval.selectedDetailLineId,
        "oauth-approval-oauth-completed:kind",
    );
    assert.deepEqual(harness.focusManager.currentFocus(), {
        boxId: approval.id,
        id: "oauth-approval-oauth-completed:kind",
        kind: "line",
    });
    assert.equal(harness.focusManager.move("down"), true);
    assert.equal(
        selectMainScreenModel(harness.store.getState()).boxes.find(
            (box) => box.id === approval.id,
        )?.selectedDetailLineId,
        "oauth-approval-oauth-completed:client",
    );
});
test("logs render timestamps and correlation metadata", () => {
    const harness = createHarness();
    harness.store.replaceLogs("alpha", [
        {
            at: "2026-07-11T12:34:56.000Z",
            callId: "call-1",
            ctxId: "session-1",
            instance: "alpha",
            message: "done",
            receivedAt: "2026-07-11T12:34:56.000Z",
            requestId: "req-1",
            seq: 21,
            source: "mcp",
            stream: "stdout",
            toolName: "bash_run",
        },
    ]);
    enterLogContext(harness, "session-1");
    const logs = expandBox(harness, "logs");
    assert.equal(
        logs.expandedLines[0]?.text,
        "2026-07-11T12:34:56.000Z stdout #21 tool=bash_run call=call-1 request=req-1 session=session-1 source=mcp done",
    );
});
test("Logs controls expose statistics and real follow state", async () => {
    const harness = createHarness();
    enterLogContext(harness, "ctx-alpha");
    const controls = expandBox(harness, "logs-controls");
    assert.equal(controls.title, "Log Controls");
    assert.equal(
        controls.expandedLines.some(
            (line) => line.text === "Follow             on",
        ),
        true,
    );
    assert.equal(
        controls.expandedLines.some(
            (line) => line.text === "Total              20",
        ),
        true,
    );
    harness.store.setMainFocusId(controls.id);
    harness.store.setFocusScope("boxDetail");
    harness.store.setSelectedDetailLine(
        controls.expandedKey,
        "logs-controls:button:toggle-follow",
    );
    await harness.dispatch({ type: "focus.activate" });
    assert.equal(harness.store.getState().ui.logsFollowByInstance.alpha, false);
    await harness.dispatch({ type: "logs.toggleFollow" });
    assert.equal(harness.store.getState().ui.logsFollowByInstance.alpha, true);
    await harness.dispatch({ type: "screen.pageUp" });
    assert.equal(harness.store.getState().ui.logsFollowByInstance.alpha, false);
});
test("Main viewport scrolling uses one page-instance offset instead of per-box offsets", async () => {
    const harness = createHarness();
    enterLogContext(harness, "ctx-alpha");
    const logs = expandBox(harness, "logs");
    harness.store.setFocusScope("mainBoxes");
    harness.store.setMainFocusId(logs.id);
    const key = selectMainScrollKey(harness.store.getState());
    await harness.dispatch({ type: "screen.pageDown" });
    assert.equal(
        (harness.store.getState().ui.scrollOffsets[key] ?? 0) > 0,
        true,
    );
    assert.equal(
        harness.store.getState().ui.scrollOffsets[logs.expandedKey],
        undefined,
    );
    assert.equal(
        selectMainScreenModel(harness.store.getState()).boxes.find(
            (box) => box.id === "logs",
        )?.expandedLines.length,
        20,
    );
});
test("Moving focus down advances the shared main viewport to keep the focused box visible", async () => {
    const harness = createHarness();
    harness.store.replaceInstances([
        ...harness.store.getState().instances,
        ...Array.from({ length: 8 }, (_, index) => ({
            enabled: true,
            mcpEnabled: false,
            name: `extra-${index}`,
            provider: "local",
        })),
    ]);
    harness.store.setSelectedPage("instances");
    harness.store.setFocusScope("mainBoxes");
    harness.store.setMainFocusId("instance:alpha");
    const key = selectMainScrollKey(harness.store.getState());
    for (let index = 0; index < 8; index += 1)
        await harness.press("", { downArrow: true });
    assert.equal(
        (harness.store.getState().ui.scrollOffsets[key] ?? 0) > 0,
        true,
    );
    assert.notEqual(harness.store.getState().ui.mainFocusId, "instance:alpha");
});
test("instance Stop is direct in the box and defaults to Cancel", async () => {
    const harness = createHarness();
    const instance = expandBox(harness, "instance:alpha");
    harness.store.setMainFocusId(instance.id);
    harness.store.setFocusScope("boxDetail");
    harness.store.setSelectedDetailLine(
        instance.expandedKey,
        "instance:alpha:button:stop",
    );
    await harness.dispatch({ type: "focus.activate" });
    const overlay = topTuiOverlay(
        harness.store.getState().interaction.overlays,
    );
    assert.equal(
        overlay?.kind === "confirmation" ? overlay.selectedAction : undefined,
        "cancel",
    );
    await harness.press("", { return: true });
    assert.deepEqual(harness.instanceActions(), []);
});
test("enabled toggle disables through confirmation and enables directly", async () => {
    const harness = createHarness();
    let instance = expandBox(harness, "instance:alpha");
    harness.store.setMainFocusId(instance.id);
    harness.store.setFocusScope("boxDetail");
    harness.store.setSelectedDetailLine(
        instance.expandedKey,
        "instance:alpha:instance.toggleEnabled:alpha",
    );
    await harness.dispatch({ type: "focus.activate" });
    const overlay = topTuiOverlay(
        harness.store.getState().interaction.overlays,
    );
    assert.equal(
        overlay?.kind === "confirmation" ? overlay.title : undefined,
        "Confirm Disable",
    );
    await harness.dispatch({ button: "confirm", type: "confirm.focus" });
    await harness.dispatch({ type: "confirm.accept" });
    assert.deepEqual(harness.enabledChanges(), [
        { enabled: false, instance: "alpha" },
    ]);

    harness.store.replaceInstances(
        harness.store
            .getState()
            .instances.map((entry) =>
                entry.name === "alpha" ? { ...entry, enabled: false } : entry,
            ),
    );
    instance = expandBox(harness, "instance:alpha");
    harness.store.setMainFocusId(instance.id);
    harness.store.setFocusScope("boxDetail");
    harness.store.setSelectedDetailLine(
        instance.expandedKey,
        "instance:alpha:instance.toggleEnabled:alpha",
    );
    await harness.dispatch({ type: "focus.activate" });
    assert.deepEqual(harness.enabledChanges(), [
        { enabled: false, instance: "alpha" },
        { enabled: true, instance: "alpha" },
    ]);
});
test("Pending Approval Enter opens an isolated approval detail without a tool form", async () => {
    const harness = createHarness();
    await openApprovalOverlay(harness);
    const overlay = topTuiOverlay(
        harness.store.getState().interaction.overlays,
    );
    assert.equal(overlay?.kind, "approval");
    assert.equal(
        overlay?.kind === "approval" ? overlay.approvalId : undefined,
        "approval-1",
    );
    assert.equal(
        overlay?.kind === "approval" ? overlay.selectedAction : undefined,
        "back",
    );
    assert.equal(
        harness.store.getState().interaction.focusScope,
        "approvalDetail",
    );
    assert.deepEqual(harness.approvalDecisions(), []);
});
test("approval detail defaults to Back and requires explicit approval confirmation", async () => {
    const harness = createHarness();
    await openApprovalOverlay(harness);
    let overlay = topTuiOverlay(harness.store.getState().interaction.overlays);
    assert.equal(
        overlay?.kind === "approval" ? overlay.selectedAction : undefined,
        "back",
    );
    await harness.press("", { downArrow: true });
    await harness.press("", { downArrow: true });
    await harness.press("", { downArrow: true });
    await harness.press("", { return: true });
    overlay = topTuiOverlay(harness.store.getState().interaction.overlays);
    assert.equal(
        overlay?.kind === "confirmation" ? overlay.title : undefined,
        "Confirm Approval",
    );
    assert.deepEqual(harness.approvalDecisions(), []);
    await harness.dispatch({ button: "confirm", type: "confirm.focus" });
    await harness.dispatch({ type: "confirm.accept" });
    assert.deepEqual(harness.approvalDecisions(), [
        { approvalId: "approval-1", decision: "approve", instance: "alpha" },
    ]);
    assert.equal(
        topTuiOverlay(harness.store.getState().interaction.overlays),
        undefined,
    );
});
test("approval detail opens the associated structured input before a decision", async () => {
    const harness = createHarness();
    await openApprovalOverlay(harness);
    await harness.press("", { downArrow: true });
    await harness.press("", { return: true });
    const overlay = topTuiOverlay(
        harness.store.getState().interaction.overlays,
    );
    assert.equal(overlay?.kind, "text-detail");
    assert.equal(
        overlay?.kind === "text-detail" ? overlay.title : undefined,
        "bash_run · approval input",
    );
    assert.equal(
        overlay?.kind === "text-detail" && /cmd:/u.test(overlay.body),
        true,
    );
    assert.deepEqual(harness.approvalDecisions(), []);
});
test("approval detail Back restores the audit list focus and scroll position", async () => {
    const harness = createHarness();
    enterAuditContext(harness, "ctx-alpha");
    const approval = expandBox(harness, "approval-approval-1");
    const key = selectMainScrollKey(harness.store.getState());
    harness.store.setScrollOffset(key, 2);
    harness.store.setMainFocusId(approval.id);
    harness.store.setFocusScope("boxDetail");
    harness.store.setSelectedDetailLine(
        approval.expandedKey,
        "approval-approval-1:approval.open:approval-1",
    );
    await harness.dispatch({ type: "focus.activate" });
    await harness.press("", { return: true });
    assert.equal(
        topTuiOverlay(harness.store.getState().interaction.overlays),
        undefined,
    );
    assert.equal(harness.store.getState().ui.mainFocusId, approval.id);
    assert.equal(harness.store.getState().ui.scrollOffsets[key], 2);
});
test("Attach Shell is invoked directly from the expanded instance box", async () => {
    const harness = createHarness();
    harness.store.replaceInstances(
        harness.store
            .getState()
            .instances.map((instance) =>
                instance.name === "alpha"
                    ? { ...instance, provider: "ssh" }
                    : instance,
            ),
    );
    const instance = expandBox(harness, "instance:alpha");
    harness.store.setMainFocusId(instance.id);
    harness.store.setFocusScope("boxDetail");
    harness.store.setSelectedDetailLine(
        instance.expandedKey,
        "instance:alpha:button:attach-shell",
    );
    await harness.dispatch({ type: "focus.activate" });
    const overlay = topTuiOverlay(
        harness.store.getState().interaction.overlays,
    );
    assert.equal(
        overlay?.kind === "confirmation" ? overlay.title : undefined,
        "UNMANAGED SHELL",
    );
    assert.deepEqual(harness.shellAttaches(), []);
    await harness.dispatch({ button: "confirm", type: "confirm.focus" });
    await harness.dispatch({ type: "confirm.accept" });
    assert.deepEqual(harness.shellAttaches(), ["alpha"]);
});
async function dispatchResult(
    harness: ReturnType<typeof createHarness>,
    intent: Parameters<TuiCommandDispatcher["dispatch"]>[0],
): Promise<boolean> {
    return await harness.commandDispatcher.dispatch(intent);
}

function expandBox(harness: ReturnType<typeof createHarness>, id: string) {
    let box = selectMainScreenModel(harness.store.getState()).boxes.find(
        (candidate) => candidate.id === id,
    );
    assert.ok(box !== undefined, `missing box ${id}`);
    if (!box.expanded) harness.store.toggleExpanded(box.expandedKey);
    box = selectMainScreenModel(harness.store.getState()).boxes.find(
        (candidate) => candidate.id === id,
    );
    assert.ok(box?.expanded, `box ${id} did not expand`);
    return box;
}

async function openPrimaryRoute(
    harness: ReturnType<typeof createHarness>,
    boxId: string,
): Promise<void> {
    harness.store.setFocusScope("mainBoxes");
    harness.store.setMainFocusId(boxId);
    await harness.dispatch({ type: "focus.activate" });
}

function enableContextMessageMcp(harness: ReturnType<typeof createHarness>): void {
    const view = harness.store.getState().configView!;
    const instances = Array.isArray(view.instances) ? view.instances : [];
    harness.store.setConfigView({
        ...view,
        instances: instances.map((value): JsonValue => {
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
                return value;
            }
            const instance = value as Record<string, JsonValue>;
            if (instance.name !== "alpha") return instance;
            const currentMcp =
                typeof instance.mcp === "object" &&
                instance.mcp !== null &&
                !Array.isArray(instance.mcp)
                    ? instance.mcp as Record<string, JsonValue>
                    : {};
            return {
                ...instance,
                mcp: {
                    ...currentMcp,
                    enabled: true,
                    tools: {
                        capabilities: ["read", "write", "execute"],
                        groups: ["context"],
                    },
                },
            };
        }),
    });
}

function conversationScreenText(harness: ReturnType<typeof createHarness>): string {
    return selectMainScreenModel(harness.store.getState()).boxes
        .flatMap((box) => [
            box.title,
            ...box.collapsedLines.map((line) => line.text),
            ...box.expandedLines.map((line) => line.text),
        ])
        .join("\n");
}

function enterAuditContext(
    harness: ReturnType<typeof createHarness>,
    ctxId: string,
): void {
    harness.store.setSelectedPage("audit");
    harness.store.pushRoute({
        ctxId,
        page: "audit",
        scope: "context",
        view: "context",
    });
}

function enterAuditUnscoped(harness: ReturnType<typeof createHarness>): void {
    harness.store.setSelectedPage("audit");
    harness.store.pushRoute({
        page: "audit",
        scope: "unscoped",
        view: "context",
    });
}

function enterLogContext(
    harness: ReturnType<typeof createHarness>,
    ctxId: string,
): void {
    harness.store.setSelectedPage("logs");
    harness.store.pushRoute({
        ctxId,
        page: "logs",
        scope: "context",
        view: "context",
    });
}

function enterConnectionsRoute(
    harness: ReturnType<typeof createHarness>,
    view: "connector" | "oauth",
): void {
    harness.store.setSelectedPage("connections");
    if (view === "connector") {
        harness.store.pushRoute({
            connectorId: "mcp",
            page: "connections",
            view: "connector",
        });
    } else {
        harness.store.pushRoute({
            page: "connections",
            providerId: "default",
            view: "oauth",
        });
    }
}

function openEditorForBox(
    harness: ReturnType<typeof createHarness>,
    kind: "config" | "connector",
    boxId: string,
): void {
    const box = expandBox(harness, boxId);
    const field = box.expandedLines.find((line) =>
        line.id?.includes(":field:"),
    );
    assert.ok(field?.id, `missing editable field in ${boxId}`);
    const key = kind === "config" ? "config:alpha" : "connector:alpha";
    if (
        kind === "config" &&
        harness.store.getState().ui.formDrafts[key] === undefined
    ) {
        harness.store.setFormDraft(
            key,
            {
                approvalPolicy: { mode: "ask" },
                enabled: true,
                mcp: {
                    enabled: true,
                    path: "/alpha/mcp",
                    tools: {
                        capabilities: ["read", "write", "execute"],
                        groups: ["file", "bash", "artifact", "context"],
                    },
                },
                name: "alpha",
                provider: "local",
                security: { mode: "disabled" },
                workspace: "/workspace/alpha",
            },
            false,
        );
    }
    if (
        kind === "connector" &&
        harness.store.getState().ui.formDrafts[key] === undefined
    ) {
        harness.store.setFormDraft(
            key,
            {
                enabled: true,
                listenHost: "127.0.0.1",
                listenPort: 3210,
            },
            false,
        );
    }
    harness.store.setEditor({ editing: false, key, kind });
    harness.store.setMainFocusId(boxId);
    harness.store.setFocusScope("form");
    harness.store.setSelectedDetailLine(box.expandedKey, field.id);
}

async function openApprovalOverlay(
    harness: ReturnType<typeof createHarness>,
): Promise<void> {
    enterAuditContext(harness, "ctx-alpha");
    const approval = expandBox(harness, "approval-approval-1");
    harness.store.setMainFocusId(approval.id);
    harness.store.setFocusScope("boxDetail");
    harness.store.setSelectedDetailLine(
        approval.expandedKey,
        "approval-approval-1:approval.open:approval-1",
    );
    await harness.dispatch({ type: "focus.activate" });
}

async function openCreateWizard(
    harness: ReturnType<typeof createHarness>,
): Promise<void> {
    await harness.press("", { tab: true });
    await harness.press(" ");
    const createBox = selectMainScreenModel(
        harness.store.getState(),
    ).boxes.find((box) => box.id === "create-instance");
    const createButton = createBox?.expandedLines.find((line) =>
        line.id?.endsWith(":button:create"),
    );
    assert.ok(createBox?.expandedKey);
    assert.ok(createButton?.id);
    harness.store.setSelectedDetailLine(createBox.expandedKey, createButton.id);
    await harness.dispatch({ type: "focus.activate" });
}

function instanceCreateSummary(
    draft: InstanceCreateDraft,
): InstanceCreateSummary {
    return {
        ...(draft.dockerBinary === undefined
            ? {}
            : { dockerBinary: draft.dockerBinary }),
        ...(draft.podmanBinary === undefined
            ? {}
            : { podmanBinary: draft.podmanBinary }),
        ...(draft.ssh === undefined ? {} : { ssh: draft.ssh }),
        ...(draft.workspace === undefined
            ? {}
            : { workspace: draft.workspace }),
        enabled: draft.enabled ?? true,
        mcp: {
            auth: draft.mcp?.auth === "oauth2"
                ? {
                      mode: "oauth2",
                      oauth2: {
                          documentationUrl: draft.mcp.oauth2?.documentationUrl,
                          requiredScopes: [...(draft.mcp.oauth2?.requiredScopes ?? [])],
                          resourceName: draft.mcp.oauth2?.resourceName ?? draft.name,
                      },
                  }
                : { mode: draft.mcp?.auth ?? "none" },
            enabled: draft.mcp?.enabled ?? true,
            path: `/${draft.name}/mcp`,
            tools: {
                capabilities: [
                    ...(draft.mcp?.tools?.capabilities ?? [
                        "read",
                        "write",
                        "execute",
                    ]),
                ],
                groups: [
                    ...(draft.mcp?.tools?.groups ?? [
                        "file",
                        "bash",
                        "artifact",
                    ]),
                ],
            },
        },
        name: draft.name,
        provider: draft.provider,
        security: { mode: draft.security?.mode ?? "disabled" },
    };
}

function createHarness(
    options: {
        onArtifactViewImage?: (
            instance: string,
            input: { handle?: string; instance?: string; path?: string },
        ) => Promise<{
            bytes: number;
            content: string;
            encoding: "base64";
            mediaType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
            name: string;
            source: unknown;
        }>;
        onAttachShell?: (instance: string) => Promise<void>;
        onOAuthApprovalDecision?: (
            approvalId: string,
            decision: "approve" | "deny",
        ) => Promise<void>;
        onConfigUpdate?: (value: Record<string, unknown>) => Promise<JsonValue>;
        onContextMessage?: (
            instance: string,
            ctxId: string,
            text: string,
        ) => Promise<void>;
        onToolCall?: (
            instance: string,
            toolName: string,
            input: string,
        ) => Promise<boolean>;
        onValidateConfigDraft?: () => Promise<void>;
        onValidateInstanceCreateDraft?: (
            draft: InstanceCreateDraft,
        ) => Promise<InstanceCreateSummary>;
    } = {},
) {
    const store = new TuiAppStore();
    seedPrompt3State(store);
    const approvalDecisions: Array<{
        approvalId: string;
        decision: string;
        instance: string;
    }> = [];
    const oauthApprovalDecisions: Array<{
        approvalId: string;
        decision: string;
    }> = [];
    const instanceActions: Array<{ action: string; instance: string }> = [];
    const enabledChanges: Array<{ enabled: boolean; instance: string }> = [];
    const shellAttaches: string[] = [];
    let logsReloadRequests = 0;
    const pageReloads: Array<{ instance: string | undefined; page: string }> =
        [];
    const focusManager = new TuiFocusManager(store, {
        currentPage: () => store.getState().ui.selectedPage,
        expandedKeyFor: (boxId) =>
            selectMainScreenModel(store.getState()).boxes.find(
                (box) => box.id === boxId,
            )?.expandedKey,
        graphFor: (page, mode) =>
            buildFocusGraphForState({
                ...store.getState(),
                interaction: {
                    ...store.getState().interaction,
                    focusScope: mode,
                },
                ui: {
                    ...store.getState().ui,
                    selectedPage: page,
                },
            }),
        mode: () => store.getState().interaction.focusScope,
    });
    const commandDispatcher = new TuiCommandDispatcher({
        focusManager,
        mainViewportRows: () => 12,
        projection: tuiViewProjection,
        onApprovalDecision: async (instance, approvalId, decision) => {
            approvalDecisions.push({ approvalId, decision, instance });
        },
        onArtifactViewImage: options.onArtifactViewImage as never,
        onInstanceAction: async (action, instance) => {
            instanceActions.push({ action, instance });
        },
        onInstanceEnabledChange: async (instance, enabled) => {
            enabledChanges.push({ enabled, instance });
        },
        onAttachShell:
            options.onAttachShell ??
            (async (instance) => {
                shellAttaches.push(instance);
            }),
        onLogsReload: async () => {
            logsReloadRequests += 1;
        },
        onPageReload: async (page, instance) => {
            pageReloads.push({ instance, page });
        },
        onOAuthApprovalDecision:
            options.onOAuthApprovalDecision ??
            (async (approvalId, decision) => {
                oauthApprovalDecisions.push({ approvalId, decision });
            }),
        onConfigUpdate: (options.onConfigUpdate ?? (async () => ({}))) as never,
        onContextMessage: options.onContextMessage,
        onQuit: async () => undefined,
        onRedraw: () => undefined,
        onToolCall: options.onToolCall ?? (async () => true),
        onGetInstanceCreateSchema: async () => ({
            container: {
                defaultMode: "preset" as const,
                modes: [
                    "preset",
                    "dockerfile",
                    "compose",
                    "existingImage",
                    "existingStoppedContainer",
                ] as const,
                presets: [],
            },
            defaultMcpCapabilities: ["read", "write", "execute"],
            defaultMcpGroups: ["file", "bash", "artifact", "context"],
            defaultEnabled: true,
            defaultMcpEnabled: true,
            defaultProvider: "local" as const,
            defaultSecurityMode: "disabled",
            providers: ["local", "ssh", "docker", "podman"] as const,
        }),
        onValidateInstanceCreateDraft:
            options.onValidateInstanceCreateDraft ??
            (async (draft) => instanceCreateSummary(draft)),
        onValidateConfigDraft:
            options.onValidateConfigDraft ?? (async () => undefined),
        store,
    });
    const keyDispatcher = new TuiKeyDispatcher();

    focusManager.syncPanel(
        store.getState().ui.selectedPage,
        store.getState().interaction.focusScope,
    );

    return {
        commandDispatcher,
        async dispatch(
            intent: Parameters<TuiCommandDispatcher["dispatch"]>[0],
        ) {
            await commandDispatcher.dispatch(intent);
        },
        async press(input: string, key: Record<string, boolean> = {}) {
            await commandDispatcher.dispatchMany(
                keyDispatcher.dispatch(
                    store.getState().interaction.focusScope,
                    { input, key },
                ),
            );
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
        store,
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
            provider: "local",
        },
        {
            defaultWorkspace: "/workspace/beta",
            enabled: true,
            mcpEnabled: false,
            mcpPath: "/beta/mcp",
            name: "beta",
            provider: "ssh",
        },
    ]);
    store.setConfigView({
        instances: [
            {
                enabled: true,
                mcp: { enabled: true, path: "/alpha/mcp" },
                name: "alpha",
                provider: "local",
                workspace: "/workspace/alpha",
            },
            {
                enabled: true,
                mcp: { enabled: false, path: "/beta/mcp" },
                name: "beta",
                provider: "ssh",
                workspace: "/workspace/beta",
            },
        ],
        mcp: {
            enabled: true,
            listenHost: "127.0.0.1",
            listenPort: 3210,
        },
    });
    store.replaceSnapshot({
        connectionState: "connected",
        daemonState: "running",
        lastSeq: 20,
        name: "alpha",
        ready: true,
        status: "ready",
    } as never);
    store.replaceSnapshot({
        connectionState: "connected",
        daemonState: "stopped",
        lastSeq: 12,
        name: "beta",
        ready: false,
        status: "stopped",
    } as never);
    store.replaceTodo("alpha", {
        items: [
            { content: "Inspect", id: "inspect", status: "completed" },
            {
                content: "Implement Todo",
                detail: "Adding dedicated TUI page",
                id: "implement",
                status: "in_progress",
            },
            { content: "Verify", id: "verify", status: "pending" },
        ],
        revision: 2,
        summary: { completed: 1, currentItemId: "implement", total: 3 },
        taskId: "task-1",
        title: "Todo support",
    });
    store.replaceToolCalls("alpha", [
        {
            callId: "call-1",
            ctxId: "ctx-alpha",
            completedAt: "2026-07-09T00:00:01.000Z",
            inputSummary: '{"cmd":"pwd"}',
            instance: "alpha" as never,
            source: "tui",
            startedAt: "2026-07-09T00:00:00.000Z",
            status: "completed",
            termination: "exited",
            toolName: "bash_run",
        },
    ]);
    store.replaceApprovals("alpha", [
        {
            approvalId: "approval-1",
            callId: "call-1",
            ctxId: "ctx-alpha",
            createdAt: "2026-07-09T00:00:00.000Z",
            expiresAt: "2026-07-09T00:10:00.000Z",
            inputSummary: '{"cmd":"rm"}',
            instance: "alpha" as never,
            reason: "needs review",
            riskLevel: "high",
            source: "tui",
            status: "pending",
            toolName: "bash_run",
        },
    ]);
    store.replaceLogs("alpha", [
        ...Array.from({ length: 20 }, (_, index) => ({
            ctxId: "ctx-alpha",
            instance: "alpha",
            message: `alpha line ${index + 1}`,
            receivedAt: `2026-07-09T00:00:${String(index).padStart(2, "0")}.000Z`,
            seq: index + 1,
            stream: "stdout" as const,
        })),
    ]);
    store.replaceLogs("beta", [
        {
            ctxId: "ctx-beta",
            instance: "beta",
            message: "beta line 1",
            receivedAt: "2026-07-09T00:01:00.000Z",
            seq: 1,
            stream: "stderr" as const,
        },
    ]);
}
