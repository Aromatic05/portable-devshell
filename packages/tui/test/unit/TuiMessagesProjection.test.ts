import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";

import { TuiAppStore } from "../../src/state/TuiAppStore.ts";
import {
    selectTuiMessageEntries,
    selectTuiMessageSessions,
    selectTuiMessagesSidebarEntries,
} from "../../src/view/page/messages/TuiMessagesProjection.ts";

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
                lastAccessedAt: "2026-09-10T09:00:00.000Z",
                principal: "client",
                status: "active",
                workspace: "/workspace/empty",
            },
        ],
        instanceState: {
            alpha: {
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

    assert.deepEqual(
        selectTuiMessageSessions(store.getState(), "alpha").map((session) => session.ctxId),
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
        selectTuiMessagesSidebarEntries(store.getState(), true, { id: "messages:back", kind: "context" })
            .map((entry) => entry.label),
        ["← messages", "project", "empty"],
    );
});
