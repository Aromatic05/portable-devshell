import assert from "node:assert/strict";
import test from "node:test";
import {
    asInstanceName,
    type ContextMessageRecord,
    type OperationalOverview,
} from "@portable-devshell/shared";
import {
    TuiRenderScheduler,
    TuiAppStore,
    selectMainScreenModel,
} from "../../src/testing.ts";
import { TuiTestDomains } from "../support/DomainHarness.js";

{
    test("TuiAppStore keeps page, instance, and expanded boxes stable across instance events", () => {
        const domains = new TuiTestDomains();
        const store = new TuiAppStore({
            domains: domains.reader,
            maxRawEvents: 2,
        });

        store.setConnectionState("connected");
        domains.setInstances([
            { enabled: true, mcpEnabled: false, name: "alpha" },
            { enabled: true, mcpEnabled: true, name: "beta" },
        ]);
        store.setSelectedPage("audit");
        store.setSelectedInstance("beta");
        store.toggleExpanded("audit:beta:test");
        domains.setRuntime("beta", {
            snapshot: {
                connectionState: "connected",
                daemonState: "running",
                lastSeq: 2,
                name: asInstanceName("beta"),
                ready: true,
                status: "ready",
            },
        });
        domains.setRuntime("beta", {
            logs: [
                {
                    at: "2026-07-09T00:00:03.000Z",
                    instanceName: "beta",
                    message: "payload",
                    seq: 3,
                    stream: "stdout",
                },
            ],
        });
        store.dispatch({
            rawEvent: { event: "log.appended", instance: "beta", seq: 3 },
            type: "event.append",
        });

        const state = store.getState();

        assert.equal(state.connection.status, "connected");
        assert.equal(state.ui.selectedPage, "audit");
        assert.equal(state.ui.selectedInstance, "beta");
        assert.equal(state.ui.expandedBoxes["audit:beta:test"], true);
        assert.equal(domains.reader.runtime("beta").logs.length, 1);
        assert.equal(domains.reader.runtime("beta").snapshot?.name, "beta");
        assert.equal(state.rawEvents.at(-1)?.seq, 3);
    });

    test("TuiRenderScheduler batches multiple store updates into one render notification", (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const store = new TuiAppStore();
        const scheduler = new TuiRenderScheduler(store, 5);
        let renderCount = 0;

        const unsubscribe = scheduler.subscribe(() => {
            renderCount += 1;
        });

        store.setConnectionState("connected");
        store.setSelectedPage("audit");
        store.setSelectedPage("help");

        assert.equal(renderCount, 0);
        t.mock.timers.tick(5);

        unsubscribe();
        scheduler.dispose();

        assert.equal(renderCount, 1);
        assert.equal(scheduler.getSnapshot().ui.selectedPage, "help");
    });

    test("TuiRenderScheduler coalesces attached domain source changes into one redraw", (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const store = new TuiAppStore();
        const scheduler = new TuiRenderScheduler(store, 2);
        const domains = new TuiTestDomains((source) =>
            scheduler.attach(source),
        );
        let renders = 0;
        const unsubscribe = scheduler.subscribe(() => {
            renders += 1;
        });

        domains.setOverview(emptyOverview());
        domains.setMessages("alpha", [contextMessage("message-1")]);
        assert.equal(renders, 0);
        t.mock.timers.tick(2);
        assert.equal(renders, 1);

        renders = 0;
        domains.setContexts([
            {
                createdAt: "2026-07-31T00:00:00.000Z",
                ctxId: "ctx-a",
                environments: [
                    { instance: "alpha", workspace: "/workspace/alpha" },
                ],
                expiresAt: "2099-07-31T00:00:00.000Z",
                lastAccessedAt: "2026-07-31T00:00:01.000Z",
                principal: "test",
                status: "active",
            },
        ]);
        assert.equal(renders, 0);
        t.mock.timers.tick(2);
        assert.equal(renders, 1);

        unsubscribe();
        scheduler.dispose();
        domains.dispose();
    });

    test("TuiRenderScheduler stops notifying listeners after dispose", (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const store = new TuiAppStore();
        const scheduler = new TuiRenderScheduler(store, 2);
        let renders = 0;
        scheduler.subscribe(() => {
            renders += 1;
        });

        scheduler.dispose();
        store.setSelectedPage("help");
        t.mock.timers.tick(2);

        assert.equal(renders, 0);
    });

    test("TuiAppStore does not publish unchanged interaction state", () => {
        const store = new TuiAppStore();
        const editor = {
            editing: false,
            key: "config:alpha",
            kind: "config" as const,
        };

        store.setFocusScope("mainBoxes");
        store.setMainFocusId("instance:alpha");
        store.setMessageScope("history");
        store.setSidebarCursor({ id: "instances", kind: "context" });
        store.setSidebarFocus("instances");
        store.setSidebarLevel("root");
        store.setSearchQuery("instances", "alpha");
        store.setEditor(editor);
        store.setSelectedDetailLine("instance:alpha", "line:alpha");
        store.setScreenStatus("instances", "ready");
        store.setSelectedInstance("alpha");
        store.setSelectedPage("help");

        let notifications = 0;
        const unsubscribe = store.subscribe(() => {
            notifications += 1;
        });

        store.setFocusScope("mainBoxes");
        store.setMainFocusId(store.getState().ui.mainFocusId);
        store.setMessageScope("history");
        store.setSidebarCursor({ id: "instances", kind: "context" });
        store.setSidebarFocus("instances");
        store.setSidebarLevel("root");
        store.setSearchQuery("instances", "alpha");
        store.setEditor(editor);
        store.setSelectedDetailLine("instance:alpha", "line:alpha");
        store.setScreenStatus("instances", "ready");
        store.setSelectedInstance("alpha");
        store.setSelectedPage("help");
        store.clearFormDraft("missing");

        unsubscribe();
        assert.equal(notifications, 0);
    });

    test("Audit page creates expensive input and output detail only for expanded records", () => {
        const domains = new TuiTestDomains();
        const store = new TuiAppStore({ domains: domains.reader });
        domains.setInstances([
            { enabled: true, mcpEnabled: true, name: "alpha" },
        ]);
        store.setSelectedInstance("alpha");
        store.setSelectedPage("audit");
        domains.setToolCalls("alpha", [
            {
                ...toolCall("large-output"),
                input: { command: "x".repeat(20_000) },
                output: { stdout: "y".repeat(20_000) },
            },
        ]);

        const contexts = selectMainScreenModel(
            store.getState(),
            domains.reader,
        ).boxes;
        assert.equal(contexts[0]?.id, "audit-scope:unscoped");

        domains.setToolCalls("alpha", [
            {
                ...toolCall("large-output"),
                ctxId: "ctx-large",
                input: { command: "x".repeat(20_000) },
                output: { stdout: "y".repeat(20_000) },
            },
        ]);
        store.pushRoute({
            ctxId: "ctx-large",
            page: "audit",
            scope: "context",
            view: "context",
        });
        const collapsed = selectMainScreenModel(
            store.getState(),
            domains.reader,
        ).boxes[0];
        assert.equal(collapsed?.expanded, false);
        assert.deepEqual(collapsed?.expandedLines, []);

        store.toggleExpanded(collapsed!.expandedKey);
        const expanded = selectMainScreenModel(store.getState(), domains.reader)
            .boxes[0];
        assert.equal(expanded?.expanded, true);
        assert.equal(
            expanded?.expandedLines.some((line) =>
                line.text.trimStart().startsWith("Input"),
            ),
            true,
        );
        assert.equal(
            expanded?.expandedLines.some((line) =>
                line.text.trimStart().startsWith("Output"),
            ),
            true,
        );
    });

    function toolCall(callId: string) {
        return {
            callId,
            inputSummary: "{}",
            instance: asInstanceName(
                callId.startsWith("beta") ? "beta" : "alpha",
            ),
            source: "mcp" as const,
            startedAt: "2026-07-28T00:00:00.000Z",
            status: "completed" as const,
            toolName: "bash_run",
        };
    }

    function emptyOverview(): OperationalOverview {
        return {
            activity: [],
            alerts: [],
            controller: { pid: 1, uptimeSeconds: 1 },
            counts: {
                failedCalls24h: 0,
                instancesAttention: 0,
                instancesCritical: 0,
                instancesReady: 0,
                instancesTotal: 0,
                pendingApprovals: 0,
            },
            generatedAt: "2026-07-31T00:00:00.000Z",
            health: "healthy",
            instances: [],
        };
    }

    function contextMessage(id: string): ContextMessageRecord {
        return {
            createdAt: "2026-07-31T00:00:00.000Z",
            ctxId: "ctx-a",
            id,
            instance: "alpha",
            status: "pending",
            text: "Review this context",
        };
    }
}
