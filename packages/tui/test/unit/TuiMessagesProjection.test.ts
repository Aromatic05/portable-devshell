import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";

import { TuiAppStore } from "../../src/state/TuiAppStore.ts";
import {
    renderTuiMessageComposerSegments,
    selectTuiMessageEntries,
    selectTuiMessageSessions,
    selectTuiMessagesSidebarEntries,
} from "../../src/view/page/messages/TuiMessagesProjection.ts";
import { TuiMessagesView } from "../../src/view/page/messages/TuiMessagesView.tsx";

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

test("Messages keeps short history at the top while reserving composer space at the bottom", () => {
    const store = new TuiAppStore();
    store.patchControlReadModel({
        instanceState: {
            alpha: {
                contextMessages: [{
                    createdAt: "2026-09-10T10:03:00.000Z",
                    ctxId: "ctx-alpha",
                    id: "comment-1",
                    instance: "alpha",
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
    assert.equal(history.props.height, 26);
    assert.equal(history.props.justifyContent, "flex-start");
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
});
