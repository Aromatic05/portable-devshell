import assert from "node:assert/strict";
import test from "node:test";
import {
    currentTuiRoute,
    selectBreadcrumbSegments,
    selectFooterShortcuts,
    selectMainScreenModel,
    selectMainScrollKey,
    TuiAppStore,
    TuiCommandDispatcherNavigation,
    type TuiCommandDispatcherFocus,
    type TuiFocusManager,
} from "../../src/testing.ts";
import { TuiTestDomains } from "../support/DomainHarness.js";

{
    function createStore(): { domains: TuiTestDomains; store: TuiAppStore } {
        const domains = new TuiTestDomains();
        const store = new TuiAppStore({ domains: domains.reader });
        domains.setInstances([
            { enabled: true, mcpEnabled: true, name: "alpha" },
            { enabled: true, mcpEnabled: true, name: "beta" },
        ]);
        store.setSelectedInstance("alpha");
        domains.setToolCalls("alpha", [
            {
                callId: "call-2",
                ctxId: "ctx-a",
                inputSummary: "{}",
                instance: "alpha" as never,
                source: "mcp",
                startedAt: "2026-07-31T00:00:00.000Z",
                status: "completed",
                toolName: "bash_run",
            },
        ]);
        return { domains, store };
    }

    test("route stacks are isolated by feature page and instance and restore route view state", () => {
        const { store } = createStore();

        store.setSelectedPage("audit");
        assert.deepEqual(currentTuiRoute(store.getState()), {
            page: "audit",
            view: "contexts",
        });
        store.setMainFocusId("audit-context:ctx-a");
        store.setScrollOffset(selectMainScrollKey(store.getState()), 7);
        store.pushRoute({
            ctxId: "ctx-a",
            page: "audit",
            scope: "context",
            view: "context",
        });
        store.setMainFocusId("audit-call:call-2");
        store.setScrollOffset(selectMainScrollKey(store.getState()), 11);

        store.setSelectedPage("config");
        store.setMainFocusId("provider");
        store.setScrollOffset(selectMainScrollKey(store.getState()), 3);

        store.setSelectedPage("audit");
        assert.deepEqual(currentTuiRoute(store.getState()), {
            ctxId: "ctx-a",
            page: "audit",
            scope: "context",
            view: "context",
        });
        assert.equal(store.getState().ui.mainFocusId, "audit-call:call-2");
        assert.equal(
            store.getState().ui.scrollOffsets[
                selectMainScrollKey(store.getState())
            ],
            11,
        );

        assert.equal(store.popRoute(), true);
        assert.deepEqual(currentTuiRoute(store.getState()), {
            page: "audit",
            view: "contexts",
        });
        assert.equal(store.getState().ui.mainFocusId, "audit-context:ctx-a");
        assert.equal(
            store.getState().ui.scrollOffsets[
                selectMainScrollKey(store.getState())
            ],
            7,
        );

        store.setSelectedInstance("beta");
        assert.deepEqual(currentTuiRoute(store.getState()), {
            page: "audit",
            view: "contexts",
        });
        assert.equal(store.getState().ui.mainFocusId, undefined);

        store.setSelectedInstance("alpha");
        assert.deepEqual(currentTuiRoute(store.getState()), {
            page: "audit",
            view: "contexts",
        });
        assert.equal(store.getState().ui.mainFocusId, "audit-context:ctx-a");
    });

    test("Extension pages use a global route stack and render TUI-owned snapshots as native boxes", () => {
        const { domains, store } = createStore();
        domains.setExtension({
            tuiPages: [
                {
                    extensionId: "access",
                    id: "access",
                    title: "Access",
                },
            ],
        });
        store.setSelectedPage("extensions");

        let model = selectMainScreenModel(store.getState(), domains.reader);
        assert.deepEqual(
            model.boxes.map((box) => box.id),
            ["extension:access"],
        );
        assert.deepEqual(model.boxes[0]?.primaryAction, {
            kind: "navigate",
            route: { page: "extensions", pageId: "access", view: "page" },
        });

        store.pushRoute({ page: "extensions", pageId: "access", view: "page" });
        assert.equal(
            selectMainScreenModel(store.getState(), domains.reader).loadState
                .kind,
            "loading",
        );
        domains.setExtension({
            tuiSnapshots: new Map([
                [
                    "access",
                    {
                        items: [
                            {
                                actions: [{ id: "disable", label: "Disable" }],
                                detail: [{ text: "target mcp" }],
                                id: "cloudflare-mcp",
                                status: "ready",
                                summary: [{ text: "cloudflared -> mcp" }],
                                title: "cloudflare-mcp",
                            },
                        ],
                    },
                ],
            ]),
        });

        model = selectMainScreenModel(store.getState(), domains.reader);
        assert.equal(model.loadState.kind, "ready");
        assert.deepEqual(
            model.boxes.map((box) => box.id),
            ["cloudflare-mcp"],
        );
        assert.deepEqual(
            selectBreadcrumbSegments(store.getState(), domains.reader),
            ["extensions", "Access"],
        );

        store.setSelectedInstance("beta");
        assert.deepEqual(currentTuiRoute(store.getState()), {
            page: "extensions",
            pageId: "access",
            view: "page",
        });
    });

    test("Messages enters a thread at the sticky bottom instead of restoring an old scroll position", () => {
        const { domains, store } = createStore();
        domains.setConversation("alpha", [
            {
                createdAt: "2026-09-11T06:00:00.000Z",
                ctxId: "ctx-a",
                id: "report-a",
                kind: "report",
                text: "latest report",
            },
        ]);
        store.setSelectedPage("messages");
        store.pushRoute({
            ctxId: "ctx-a",
            instance: "alpha",
            page: "messages",
            view: "thread",
        });
        let key = selectMainScrollKey(store.getState());
        assert.equal(
            store.getState().ui.scrollOffsets[key],
            Number.MAX_SAFE_INTEGER,
        );

        store.setScrollOffset(key, 0);
        store.setSelectedPage("audit");
        store.setSelectedPage("messages");
        key = selectMainScrollKey(store.getState());
        assert.equal(
            store.getState().ui.scrollOffsets[key],
            Number.MAX_SAFE_INTEGER,
            "re-entering a conversation must start at its newest content",
        );
    });

    test("resource refresh removes invalid trailing routes instead of retaining a blank detail page", () => {
        const { domains, store } = createStore();
        store.setSelectedPage("audit");
        domains.setToolCalls("alpha", [
            {
                callId: "call-1",
                ctxId: "ctx-a",
                inputSummary: "{}",
                instance: "alpha" as never,
                source: "mcp",
                startedAt: "2026-07-31T00:00:00.000Z",
                status: "completed",
                toolName: "bash_run",
            },
        ]);
        store.pushRoute({
            ctxId: "ctx-a",
            page: "audit",
            scope: "context",
            view: "context",
        });

        domains.setToolCalls("alpha", []);

        store.bumpRedrawNonce();
        assert.deepEqual(currentTuiRoute(store.getState()), {
            page: "audit",
            view: "contexts",
        });
    });

    test("footer breadcrumb follows the route stack and excludes overlay state", () => {
        const { domains, store } = createStore();
        store.setSelectedPage("audit");
        domains.setToolCalls("alpha", [
            {
                callId: "bash_run",
                inputSummary: "{}",
                instance: "alpha" as never,
                source: "mcp",
                startedAt: "2026-07-31T00:00:00.000Z",
                status: "completed",
                toolName: "bash_run",
            },
        ]);
        store.pushRoute({
            page: "audit",
            scope: "unscoped",
            view: "context",
        });
        store.pushOverlay({
            body: "Confirm action",
            cancelLabel: "Cancel",
            confirmIntent: { type: "ui.cancel" },
            confirmLabel: "Confirm",
            kind: "confirmation",
            selectedAction: "cancel",
            title: "Confirm",
        });

        assert.deepEqual(
            selectBreadcrumbSegments(store.getState(), domains.reader),
            ["audit", "unscoped"],
        );
    });

    test("Audit footer exposes Comment only on concrete Context routes", () => {
        const { store } = createStore();
        store.setSelectedPage("audit");
        store.setFocusScope("mainBoxes");

        assert.equal(
            selectFooterShortcuts(store.getState()).includes("m comment"),
            false,
        );

        store.pushRoute({
            ctxId: "ctx-a",
            page: "audit",
            scope: "context",
            view: "context",
        });
        assert.equal(
            selectFooterShortcuts(store.getState()).includes("m comment"),
            true,
        );

        store.setFocusScope("boxDetail");
        assert.equal(
            selectFooterShortcuts(store.getState()).includes("m comment"),
            true,
        );
    });

    test("section sidebar footer prioritizes the actions available at the current location", () => {
        const { store } = createStore();
        store.setSelectedPage("messages");
        store.setFocusScope("sidebarContext");

        assert.deepEqual(selectFooterShortcuts(store.getState()), [
            "enter open/toggle",
            "d hide",
            "/ search",
            "esc back",
            "? help",
            "0-9 pages",
            "shift+1-9 instances",
        ]);

        store.setMessageScope("hidden");
        assert.equal(
            selectFooterShortcuts(store.getState()).includes("u restore"),
            true,
        );
    });

    test("Audit Comment footer reflects browse and edit modes", () => {
        const { store } = createStore();
        store.setSelectedPage("audit");
        store.pushRoute({
            ctxId: "ctx-a",
            page: "audit",
            scope: "context",
            view: "conversation",
        });
        store.setFocusScope("mainBoxes");

        assert.deepEqual(selectFooterShortcuts(store.getState()), [
            "space expand",
            "↑↓ draft",
            "enter edit",
            "esc back",
        ]);

        store.setFocusScope("contextConversation");
        assert.deepEqual(selectFooterShortcuts(store.getState()), [
            "type",
            "enter send",
            "pgup/pgdn",
            "esc",
        ]);
    });

    test("Todo detail breadcrumb uses the task title instead of the selected instance", () => {
        const { domains, store } = createStore();
        domains.setTodo("alpha", {
            items: [],
            revision: 1,
            summary: { completed: 0, total: 0 },
            tasks: [
                {
                    completed: 0,
                    revision: 1,
                    status: "pending",
                    taskId: "task-1",
                    title: "Implement router",
                    total: 3,
                    updatedAt: "2026-07-31T00:00:00.000Z",
                },
            ],
        });
        store.setSelectedPage("todo");
        store.pushRoute({ page: "todo", todoId: "task-1", view: "detail" });

        assert.deepEqual(
            selectBreadcrumbSegments(store.getState(), domains.reader),
            ["todo", "Implement router"],
        );
    });

    test("page changes made from the sidebar preserve sidebar focus until the user enters the page", () => {
        const { store } = createStore();
        store.setFocusScope("sidebarContext");

        store.setSelectedPage("terminal");

        assert.equal(store.getState().interaction.focusScope, "sidebarContext");
    });
}
