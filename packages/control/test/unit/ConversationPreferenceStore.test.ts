import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { ConversationPreferenceStore } from "../../src/control/conversation/ConversationPreferenceStore.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("ConversationPreferenceStore persists titles and ordering across reopen", async () => {
    const root = await createTestTempDirectory("conversation-preferences");
    const filePath = join(root, "conversation-preferences.json");
    const first = new ConversationPreferenceStore(filePath);

    assert.deepEqual(await first.read(), {
        orderByWorkspace: {},
        titles: {},
        version: 1,
        workspaceOrder: []
    });
    await first.update({
        orderByWorkspace: {
            "/work/portable-devshell": ["alpha\u0000ctx-b", "alpha\u0000ctx-a"]
        },
        titles: {
            "alpha\u0000ctx-a": "Audit regression"
        },
        workspaceOrder: ["/work/portable-devshell", "/work/efilinux"]
    });

    const reopened = new ConversationPreferenceStore(filePath);
    assert.deepEqual(await reopened.read(), {
        orderByWorkspace: {
            "/work/portable-devshell": ["alpha\u0000ctx-b", "alpha\u0000ctx-a"]
        },
        titles: {
            "alpha\u0000ctx-a": "Audit regression"
        },
        version: 1,
        workspaceOrder: ["/work/portable-devshell", "/work/efilinux"]
    });
});

test("ConversationPreferenceStore applies incremental patches without clobbering unrelated browser changes", async () => {
    const root = await createTestTempDirectory("conversation-preferences-merge");
    const store = new ConversationPreferenceStore(join(root, "conversation-preferences.json"));

    await store.update({
        orderByWorkspace: { "/work/a": ["alpha\u0000ctx-a"] },
        titles: { "alpha\u0000ctx-a": "A" },
        workspaceOrder: ["/work/a"]
    });
    await store.update({ titles: { "alpha\u0000ctx-b": "B" } });
    await store.update({ orderByWorkspace: { "/work/a": ["alpha\u0000ctx-b", "alpha\u0000ctx-a"] } });

    assert.deepEqual(await store.read(), {
        orderByWorkspace: { "/work/a": ["alpha\u0000ctx-b", "alpha\u0000ctx-a"] },
        titles: {
            "alpha\u0000ctx-a": "A",
            "alpha\u0000ctx-b": "B"
        },
        version: 1,
        workspaceOrder: ["/work/a"]
    });
});

test("ConversationPreferenceStore imports only preference fields that are still missing on the server", async () => {
    const root = await createTestTempDirectory("conversation-preferences-initialize");
    const store = new ConversationPreferenceStore(join(root, "conversation-preferences.json"));
    await store.update({
        orderByWorkspace: { "/work/a": ["alpha\u0000ctx-server"] },
        workspaceOrder: ["/work/a"],
    });

    const imported = await store.update({
        ifMissing: true,
        orderByWorkspace: { "/work/a": ["alpha\u0000ctx-stale"] },
        titles: { "alpha\u0000ctx-a": "Imported" },
        workspaceOrder: ["/work/stale"],
    });
    assert.equal(imported.titles["alpha\u0000ctx-a"], "Imported");
    assert.deepEqual(imported.orderByWorkspace["/work/a"], [
        "alpha\u0000ctx-stale",
        "alpha\u0000ctx-server",
    ]);
    assert.deepEqual(imported.workspaceOrder, ["/work/a", "/work/stale"]);

    const retained = await store.update({
        ifMissing: true,
        titles: {
            "alpha\u0000ctx-a": "Stale browser copy",
            "alpha\u0000ctx-b": "Another imported title",
        },
    });
    assert.equal(retained.titles["alpha\u0000ctx-a"], "Imported");
    assert.equal(retained.titles["alpha\u0000ctx-b"], "Another imported title");
});
