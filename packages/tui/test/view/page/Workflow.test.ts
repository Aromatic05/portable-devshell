import assert from "node:assert/strict";
import test from "node:test";
import {
    type TodoReadResult,
    type TodoTaskSummary,
} from "@portable-devshell/shared";
import {
    buildFocusGraphForState,
    currentTuiRoute,
    selectBreadcrumbSegments,
    selectMainScreenModel,
    TuiAppStore,
    TuiCommandDispatcherFocus,
    TuiCommandDispatcherNavigation,
    TuiFocusManager,
} from "../../../src/testing.ts";
import { TuiTestDomains } from "../../support/DomainHarness.js";

// View/page coverage for the Todo (workflow) page. The previous test drove a
// real TuiRuntime across a control socket to prove the on-demand `todo.read`
// round-trip. That transport behavior remains covered by the TUI control
// session integration tests; these tests exercise the Todo view projection
// plus the route/focus/expansion interaction surface directly.
{
    const taskSummary: TodoTaskSummary = {
        completed: 1,
        currentItem: "Implement Todo",
        revision: 2,
        status: "in_progress",
        taskId: "task-1",
        title: "Todo support",
        total: 3,
        updatedAt: "2026-07-31T00:00:00.000Z",
    };

    // Overview read: the control read model exposes task summaries before the
    // full item list has been loaded for the active task.
    const summariesOnlyTodo: TodoReadResult = {
        items: [],
        revision: 0,
        summary: { completed: 0, total: 0 },
        tasks: [taskSummary],
    };

    // Detail read: the active task together with its full item list.
    const activeTodo: TodoReadResult = {
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
        tasks: [taskSummary],
        title: "Todo support",
    };

    function createWorkflow() {
        const domains = new TuiTestDomains();
        const store = new TuiAppStore();
        domains.setInstances([
            { enabled: true, mcpEnabled: false, name: "alpha" },
        ]);
        store.setSelectedInstance("alpha");

        const projection = domains.projection;
        const focus = new TuiCommandDispatcherFocus({
            mainViewportRows: () => 12,
            projection,
            store,
        });
        const focusManager = new TuiFocusManager(store, {
            boxIdForLine: (lineId) =>
                selectMainScreenModel(
                    store.getState(),
                    domains.reader,
                ).boxes.find((box) =>
                    box.expandedLines.some((line) => line.id === lineId),
                )?.id,
            currentPage: () => store.getState().ui.selectedPage,
            expandedKeyFor: (boxId) =>
                selectMainScreenModel(
                    store.getState(),
                    domains.reader,
                ).boxes.find((box) => box.id === boxId)?.expandedKey,
            graphFor: (page, mode) =>
                buildFocusGraphForState(
                    {
                        ...store.getState(),
                        interaction: {
                            ...store.getState().interaction,
                            focusScope: mode,
                        },
                        ui: { ...store.getState().ui, selectedPage: page },
                    },
                    domains.reader,
                ),
            mode: () => store.getState().interaction.focusScope,
        });
        const navigation = new TuiCommandDispatcherNavigation({
            focus,
            focusManager,
            onPageReload: async () => undefined,
            onRedraw: () => undefined,
            projection,
            store,
        });

        return { domains, navigation, store };
    }

    test("Todo overview projects task summaries as navigable boxes without preloading items", () => {
        const { domains, store } = createWorkflow();
        domains.setTodo("alpha", summariesOnlyTodo);
        store.setSelectedPage("todo");

        const boxes = selectMainScreenModel(
            store.getState(),
            domains.reader,
        ).boxes;
        assert.deepEqual(
            boxes.map((box) => box.id),
            ["todo-task:task-1"],
        );
        assert.equal(
            boxes.some((box) => box.id.startsWith("todo-item:")),
            false,
            "overview uses summaries; items arrive with the detail read",
        );

        const [task] = boxes;
        assert.ok(task);
        assert.deepEqual(task.primaryAction, {
            kind: "navigate",
            route: { page: "todo", todoId: "task-1", view: "detail" },
        });
        assert.equal(task.enterable, true);
        assert.match(task.collapsedLines[0].text, /progress=1\/3/u);
    });

    test("Todo detail falls back to the summary until the full item read is loaded", () => {
        const { domains, store } = createWorkflow();
        domains.setTodo("alpha", summariesOnlyTodo);
        store.setSelectedPage("todo");
        store.pushRoute({ page: "todo", todoId: "task-1", view: "detail" });

        const boxes = selectMainScreenModel(
            store.getState(),
            domains.reader,
        ).boxes;
        assert.deepEqual(
            boxes.map((box) => box.id),
            ["todo-summary:task-1"],
        );

        const summary = boxes[0];
        assert.ok(summary);
        store.toggleExpanded(summary.expandedKey);
        const expanded = selectMainScreenModel(
            store.getState(),
            domains.reader,
        ).boxes.find((box) => box.id === "todo-summary:task-1");
        assert.equal(expanded?.expanded, true);
        assert.ok(
            expanded?.expandedLines.some((line) =>
                line.text.includes("Full item data is not present"),
            ),
        );
    });

    test("Todo detail projects the task summary, sub-items, progress, and breadcrumb", () => {
        const { domains, store } = createWorkflow();
        domains.setTodo("alpha", activeTodo);
        store.setSelectedPage("todo");
        store.pushRoute({ page: "todo", todoId: "task-1", view: "detail" });
        store.setFocusScope("mainBoxes");
        store.setMainFocusId("todo-summary:task-1");

        const boxes = selectMainScreenModel(
            store.getState(),
            domains.reader,
        ).boxes;
        assert.deepEqual(
            boxes.map((box) => box.id),
            [
                "todo-summary:task-1",
                "todo-item:inspect",
                "todo-item:implement",
                "todo-item:verify",
            ],
        );
        assert.deepEqual(
            selectBreadcrumbSegments(store.getState(), domains.reader),
            ["todo", "Todo support"],
        );

        const collapsedSummary = boxes.find(
            (box) => box.id === "todo-summary:task-1",
        );
        assert.ok(collapsedSummary);
        store.toggleExpanded(collapsedSummary.expandedKey);
        const summary = selectMainScreenModel(
            store.getState(),
            domains.reader,
        ).boxes.find((box) => box.id === "todo-summary:task-1");
        assert.equal(summary?.expanded, true);
        assert.ok(
            summary?.expandedLines.some((line) => line.text.includes("1/3")),
            "detail summary should show progress",
        );
        assert.ok(
            summary?.expandedLines.some(
                (line) =>
                    line.text.includes("Level") &&
                    line.text.includes("0 · root"),
            ),
        );

        const collapsedImplement = boxes.find(
            (box) => box.id === "todo-item:implement",
        );
        assert.ok(collapsedImplement);
        store.toggleExpanded(collapsedImplement.expandedKey);
        const implement = selectMainScreenModel(
            store.getState(),
            domains.reader,
        ).boxes.find((box) => box.id === "todo-item:implement");
        assert.equal(implement?.expanded, true);
        assert.ok(
            implement?.expandedLines.some((line) =>
                line.text.includes("Adding dedicated TUI page"),
            ),
            "detail should render the sub-item description",
        );
        assert.ok(
            implement?.expandedLines.some(
                (line) =>
                    line.text.includes("Level") &&
                    line.text.includes("1 · subtask"),
            ),
            "detail should render the sub-item hierarchy level",
        );
    });

    test("Todo overview routes to detail and back while Space only toggles expansion", async () => {
        const { domains, navigation, store } = createWorkflow();
        domains.setTodo("alpha", activeTodo);
        store.setSelectedPage("todo");

        await navigation.dispatch({ direction: "next", type: "focus.move" });
        assert.equal(store.getState().interaction.focusScope, "mainBoxes");
        assert.equal(store.getState().ui.mainFocusId, "todo-task:task-1");

        await navigation.dispatch({ type: "screen.toggle" });
        assert.equal(
            store.getState().ui.expandedBoxes["todo:alpha:todo-task:task-1"],
            true,
        );
        assert.deepEqual(currentTuiRoute(store.getState()), {
            page: "todo",
            view: "overview",
        });
        await navigation.dispatch({ type: "screen.toggle" });
        assert.equal(
            store.getState().ui.expandedBoxes["todo:alpha:todo-task:task-1"],
            false,
        );
        assert.deepEqual(currentTuiRoute(store.getState()), {
            page: "todo",
            view: "overview",
        });

        assert.equal(navigation.openFocusedRoute(), true);
        assert.deepEqual(currentTuiRoute(store.getState()), {
            page: "todo",
            todoId: "task-1",
            view: "detail",
        });
        assert.equal(store.getState().ui.mainFocusId, "todo-summary:task-1");

        await navigation.dispatch({ direction: "down", type: "focus.move" });
        assert.equal(store.getState().ui.mainFocusId, "todo-item:inspect");
        await navigation.dispatch({ direction: "down", type: "focus.move" });
        assert.equal(store.getState().ui.mainFocusId, "todo-item:implement");

        assert.equal(navigation.cancelPassiveScope(), true);
        assert.deepEqual(currentTuiRoute(store.getState()), {
            page: "todo",
            view: "overview",
        });
        assert.equal(store.getState().ui.mainFocusId, "todo-task:task-1");
    });
}
