import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { WriteStream } from "node:tty";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import { asInstanceName } from "@portable-devshell/shared";
import { render } from "ink";

import { TuiAppStore } from "../../src/state/TuiAppStore.ts";
import {
    renderTuiMessageComposerSegments,
    renderTuiMessageHistoryLines,
    selectTuiMessageEntries,
    selectTuiMessageSessions,
    selectTuiMessagesSidebarEntries,
    tuiMessagesHistoryRows,
    tuiMessagesRenderedHistoryRows,
} from "../../src/view/page/messages/TuiMessagesProjection.ts";
import { TuiMessagesView } from "../../src/view/page/messages/TuiMessagesView.tsx";
import { TuiRootLayout } from "../../src/view/TuiRootLayout.tsx";

test("Messages merges registered sessions with exact comment and report history", () => {
    const store = new TuiAppStore();
    store.patchControlReadModel({
        contexts: [
            {
                createdAt: "2026-09-10T10:00:00.000Z",
                ctxId: "ctx-alpha",
                environments: [{ instance: "alpha", workspace: "/workspace/project" }],
                expiresAt: "2099-09-10T10:00:00.000Z",
                instance: "alpha",
                lastAccessedAt: "2026-09-10T10:02:00.000Z",
                principal: "client",
                status: "active",
                workspace: "/workspace/project",
            },
            {
                createdAt: "2026-09-10T09:00:00.000Z",
                ctxId: "ctx-empty",
                environments: [{ instance: "alpha", workspace: "/workspace/empty" }],
                expiresAt: "2099-09-10T10:00:00.000Z",
                instance: "alpha",
                lastAccessedAt: "2026-09-10T10:04:00.000Z",
                principal: "client",
                status: "active",
                workspace: "/workspace/empty",
            },
        ],
        instanceState: {
            alpha: {
                conversationEntries: [
                    {
                        createdAt: "2026-09-10T10:03:00.000Z",
                        ctxId: "ctx-alpha",
                        id: "comment-1",
                        kind: "comment",
                        status: "sent",
                        text: "user comment",
                    },
                    {
                        callId: "report-1",
                        createdAt: "2026-09-10T10:04:00.000Z",
                        ctxId: "ctx-alpha",
                        id: "report-1",
                        kind: "report",
                        text: "agent report",
                    },
                ],
                contextMessages: [
                    {
                        createdAt: "2026-09-10T10:03:00.000Z",
                        ctxId: "ctx-alpha",
                        id: "comment-1",
                        instance: "alpha",
                        status: "sent",
                        text: "user comment",
                    },
                ],
                reportCalls: [
                    {
                        callId: "report-1",
                        completedAt: "2026-09-10T10:04:00.000Z",
                        ctxId: "ctx-alpha",
                        input: { message: "agent report" },
                        inputSummary: '{"message":"agent report"}',
                        instance: asInstanceName("alpha"),
                        source: "mcp",
                        startedAt: "2026-09-10T10:03:59.000Z",
                        status: "completed",
                        toolName: "todo_report",
                    },
                ],
            },
        },
    });
    store.setSelectedInstance("alpha");
    store.setSelectedPage("messages");
    const now = Date.parse("2026-09-10T10:05:00.000Z");

    assert.deepEqual(
        selectTuiMessageSessions(store.getState(), "alpha", now).map((session) => session.ctxId),
        ["ctx-alpha", "ctx-empty"],
    );
    assert.deepEqual(
        selectTuiMessageEntries(store.getState(), "alpha", "ctx-alpha").map((entry) => [entry.kind, entry.text]),
        [
            ["comment", "user comment"],
            ["report", "agent report"],
        ],
    );
    assert.deepEqual(
        selectTuiMessagesSidebarEntries(store.getState(), true, { id: "messages:back", kind: "context" }, now)
            .map((entry) => entry.label),
        ["← messages", "project", "empty"],
    );
});

test("Messages hides sessions that were inactive for more than 30 minutes", () => {
    const store = new TuiAppStore();
    store.patchControlReadModel({
        contexts: [
            {
                createdAt: "2026-09-10T10:00:00.000Z",
                ctxId: "ctx-recent",
                environments: [{ instance: "alpha", workspace: "/workspace/recent" }],
                expiresAt: "2099-09-10T10:00:00.000Z",
                instance: "alpha",
                lastAccessedAt: "2026-09-10T10:02:00.000Z",
                principal: "client",
                status: "active",
                workspace: "/workspace/recent",
            },
            {
                createdAt: "2026-09-10T09:00:00.000Z",
                ctxId: "ctx-stale",
                environments: [{ instance: "alpha", workspace: "/workspace/stale" }],
                expiresAt: "2099-09-10T10:00:00.000Z",
                instance: "alpha",
                lastAccessedAt: "2026-09-10T09:20:00.000Z",
                principal: "client",
                status: "active",
                workspace: "/workspace/stale",
            },
        ],
    });
    store.setSelectedInstance("alpha");
    store.setSelectedPage("messages");
    const now = Date.parse("2026-09-10T10:05:00.000Z");

    assert.deepEqual(
        selectTuiMessageSessions(store.getState(), "alpha", now).map((session) => session.ctxId),
        ["ctx-recent"],
    );
    assert.deepEqual(
        selectTuiMessagesSidebarEntries(store.getState(), true, { id: "messages:back", kind: "context" }, now)
            .map((entry) => entry.label),
        ["← messages", "recent"],
    );
});

test("Messages keeps the composer directly after short history instead of moving blank rows around it", () => {
    const store = new TuiAppStore();
    store.patchControlReadModel({
        instanceState: {
            alpha: {
                conversationEntries: [{
                    createdAt: "2026-09-10T10:03:00.000Z",
                    ctxId: "ctx-alpha",
                    id: "comment-1",
                    kind: "comment",
                    status: "delivered",
                    text: "short history",
                }],
            },
        },
    });
    store.setSelectedInstance("alpha");
    store.setSelectedPage("messages");
    store.replaceRoute({ ctxId: "ctx-alpha", page: "messages", view: "thread" });

    const view = TuiMessagesView({ state: store.getState(), viewportRows: 30, width: 80 });
    const history = view.props.children[0];
    assert.equal(view.props.height, undefined, "Messages content must not reserve the whole viewport");
    assert.equal(history.props.height, 3);
    assert.equal(history.props.justifyContent, undefined);
    assert.equal(tuiMessagesRenderedHistoryRows(200, 30), tuiMessagesHistoryRows(30));

    const layout = TuiRootLayout({
        columns: 120,
        fitMainContent: true,
        footer: "footer",
        header: "header",
        main: view,
        rows: 40,
        sidebar: "sidebar",
    });
    const middle = layout.props.children[1];
    const mainPanel = middle.props.children[3];
    assert.equal(mainPanel.props.alignSelf, "flex-start");
});

test("Messages Ink frame reserves one physical separator row per conversation entry", async () => {
    const store = new TuiAppStore();
    store.patchControlReadModel({
        instanceState: {
            alpha: {
                conversationEntries: Array.from({ length: 8 }, (_, index) => ({
                    createdAt: `2026-09-10T10:${String(index).padStart(2, "0")}:00.000Z`,
                    ctxId: "ctx-alpha",
                    id: `comment-${index}`,
                    kind: "comment" as const,
                    status: "delivered" as const,
                    text: `frame comment ${index}`,
                })),
            },
        },
    });
    store.setSelectedInstance("alpha");
    store.setSelectedPage("messages");
    store.replaceRoute({ ctxId: "ctx-alpha", page: "messages", view: "thread" });

    const output = new PassThrough() as PassThrough & {
        columns: number;
        isTTY: true;
        rows: number;
    };
    output.columns = 80;
    output.isTTY = true;
    output.rows = 30;
    let captured = "";
    output.on("data", (chunk) => { captured += chunk.toString(); });
    const ink = render(
        TuiMessagesView({ state: store.getState(), viewportRows: 30, width: 80 }),
        { debug: true, stdout: output as unknown as WriteStream },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    ink.cleanup();

    const lines = stripVTControlCharacters(captured).split("\n");
    const lastBodyRow = lines.reduce(
        (latest, line, index) => line.includes("frame comment") ? index : latest,
        -1,
    );
    const composerRow = lines.findIndex((line) => line.includes("> Write a comment"));
    assert.notEqual(lastBodyRow, -1);
    assert.notEqual(composerRow, -1);
    assert.equal(
        composerRow - lastBodyRow,
        3,
        `expected body + one physical blank row + divider before composer, got ${composerRow - lastBodyRow - 2} blank rows\n${lines.join("\n")}`,
    );
});

test("Messages composer owns an inline cursor cell", () => {
    assert.deepEqual(renderTuiMessageComposerSegments("中文", 1, true), [
        { text: "中" },
        { text: "文", underline: true },
        { text: "" },
    ]);
    assert.deepEqual(renderTuiMessageComposerSegments("中文", 2, false), [
        { text: "中文" },
        { text: " ", underline: undefined },
        { text: "" },
    ]);
    assert.deepEqual(renderTuiMessageComposerSegments("👩‍💻x", 0, true), [
        { text: "" },
        { text: "👩‍💻", underline: true },
        { text: "x" },
    ]);
});

test("Messages reuses wrapped history while only editor state changes", () => {
    const store = new TuiAppStore();
    store.patchControlReadModel({ instanceState: { alpha: { conversationEntries: [{
        createdAt: "2026-09-10T10:03:00.000Z",
        ctxId: "ctx-alpha",
        id: "comment-1",
        kind: "comment",
        status: "delivered",
        text: "history ".repeat(200),
    }] } } });
    const first = renderTuiMessageHistoryLines(store.getState(), "alpha", "ctx-alpha", 80);
    store.setFormDraft("messages:alpha:ctx-alpha", "editing", true);
    const second = renderTuiMessageHistoryLines(store.getState(), "alpha", "ctx-alpha", 80);
    assert.equal(second, first, "editing must not re-wrap unchanged conversation history");
});
