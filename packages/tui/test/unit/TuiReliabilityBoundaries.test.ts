import assert from "node:assert/strict";
import test from "node:test";

import type { ContextMessageRecord, JsonValue } from "@portable-devshell/shared";

import {
    TuiAppStore,
    TuiKeyDispatcher,
    TuiRuntimeOperations,
    auditInputText,
} from "../../src/testing.ts";

test("text input scopes preserve multi-character paste payloads", () => {
    const dispatcher = new TuiKeyDispatcher();
    const paste = "echo pasted text";

    assert.deepEqual(dispatcher.dispatch("search", { input: paste, key: {} }), [
        { text: paste, type: "search.append" },
    ]);
    assert.deepEqual(dispatcher.dispatch("contextConversation", { input: paste, key: {} }), [
        { text: paste, type: "contextConversation.append" },
    ]);
    assert.deepEqual(dispatcher.dispatch("toolForm", { input: paste, key: {} }), [
        { text: paste, type: "toolForm.append" },
    ]);
    assert.deepEqual(dispatcher.dispatch("form", { input: paste, key: {} }), [
        { text: paste, type: "editor.append" },
    ]);
});

test("audit formatting truncates deeply nested values instead of overflowing the stack", () => {
    const root: Record<string, JsonValue> = {};
    let cursor = root;
    for (let index = 0; index < 15_000; index += 1) {
        const next: Record<string, JsonValue> = {};
        cursor.next = next;
        cursor = next;
    }

    const text = auditInputText(root, undefined);

    assert.match(text, /truncated|max depth/u);
    assert.equal(text.length < 210_000, true);
});

test("a committed context message remains successful when the follow-up audit refresh fails", async () => {
    const store = new TuiAppStore();
    const queued: ContextMessageRecord = {
        createdAt: "2026-08-01T00:00:00.000Z",
        ctxId: "ctx-1",
        id: "message-1",
        instance: "alpha",
        status: "pending",
        text: "review this",
    };
    const operations = new TuiRuntimeOperations({
        clients: {
            contextMessage: {
                async queue() { return queued; },
            },
        } as never,
        operationTimeoutMs: 100,
        session: {
            async refreshAudit() { throw new Error("audit refresh failed"); },
        } as never,
        store,
    });

    await operations.queueContextMessage("alpha", "ctx-1", "review this");

    assert.equal(store.getState().contextMessagesByInstance.alpha?.[0]?.id, "message-1");
    assert.equal(store.getState().panelErrors["audit:alpha:operationRefresh"]?.message, "audit refresh failed");
});


test("runtime commands time out and leave the running state", async () => {
    const store = new TuiAppStore();
    store.patchControlReadModel({ instances: [{
        defaultWorkspace: "/workspace/alpha",
        enabled: true,
        mcpEnabled: false,
        name: "alpha",
        provider: "local",
    }] });
    const operations = new TuiRuntimeOperations({
        clients: {
            runtime: {
                async start() { return await new Promise<never>(() => undefined); },
            },
        } as never,
        operationTimeoutMs: 15,
        session: {
            applyAuthoritativeSnapshot(value: never) {
                store.patchControlSnapshot(value);
            },
        } as never,
        store,
    });

    await operations.runInstanceAction("start", "alpha");

    const command = store.getState().commandRecords[0];
    assert.equal(command?.status, "failed");
    assert.match(command?.error?.message ?? "", /timed out/u);
});
