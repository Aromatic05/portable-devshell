import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { databaseCapability } from "../helpers/Database.ts";
import { join } from "node:path";
import test from "node:test";

import { MessagePreferenceStore } from "../../src/message/preference/Store.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("MessagePreferenceStore persists titles and ordering across reopen", async () => {
    const root = await createTestTempDirectory("message-preferences");
    const filePath = join(root, "message-preferences.json");
    const first = new MessagePreferenceStore(
        filePath,
        databaseCapability(() => join(root, "message-preferences.sqlite3")),
    );

    assert.deepEqual(await first.read(), {
        hiddenContexts: {},
        orderByWorkspace: {},
        titles: {},
        version: 1,
        workspaceOrder: [],
    });
    await first.update({
        hiddenContexts: {
            "ctx-hidden": true,
        },
        orderByWorkspace: {
            "/work/portable-devshell": ["alpha\u0000ctx-b", "alpha\u0000ctx-a"],
        },
        titles: {
            "alpha\u0000ctx-a": "Audit regression",
        },
        workspaceOrder: ["/work/portable-devshell", "/work/efilinux"],
    });

    const reopened = new MessagePreferenceStore(
        filePath,
        databaseCapability(() => join(root, "message-preferences.sqlite3")),
    );
    assert.deepEqual(await reopened.read(), {
        hiddenContexts: {
            "ctx-hidden": true,
        },
        orderByWorkspace: {
            "/work/portable-devshell": ["alpha\u0000ctx-b", "alpha\u0000ctx-a"],
        },
        titles: {
            "alpha\u0000ctx-a": "Audit regression",
        },
        version: 1,
        workspaceOrder: ["/work/portable-devshell", "/work/efilinux"],
    });
});

test("MessagePreferenceStore applies incremental patches without clobbering unrelated browser changes", async () => {
    const root = await createTestTempDirectory("message-preferences-merge");
    const store = new MessagePreferenceStore(
        join(root, "message-preferences.json"),
        databaseCapability(() => join(root, "message-preferences.sqlite3")),
    );

    await store.update({
        hiddenContexts: { "ctx-a": true },
        orderByWorkspace: { "/work/a": ["alpha\u0000ctx-a"] },
        titles: { "alpha\u0000ctx-a": "A" },
        workspaceOrder: ["/work/a"],
    });
    await store.update({ titles: { "alpha\u0000ctx-b": "B" } });
    await store.update({
        hiddenContexts: { "ctx-a": null, "ctx-b": true },
    });
    await store.update({
        orderByWorkspace: {
            "/work/a": ["alpha\u0000ctx-b", "alpha\u0000ctx-a"],
        },
    });

    assert.deepEqual(await store.read(), {
        hiddenContexts: {
            "ctx-b": true,
        },
        orderByWorkspace: {
            "/work/a": ["alpha\u0000ctx-b", "alpha\u0000ctx-a"],
        },
        titles: {
            "alpha\u0000ctx-a": "A",
            "alpha\u0000ctx-b": "B",
        },
        version: 1,
        workspaceOrder: ["/work/a"],
    });
});

test("MessagePreferenceStore imports only preference fields that are still missing on the server", async () => {
    const root = await createTestTempDirectory(
        "message-preferences-initialize",
    );
    const store = new MessagePreferenceStore(
        join(root, "message-preferences.json"),
        databaseCapability(() => join(root, "message-preferences.sqlite3")),
    );
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

test("MessagePreferenceStore migrates legacy JSON once without destroying the original", async () => {
    const root = await createTestTempDirectory("message-preferences-legacy");
    const legacy = join(root, "message-preferences.json");
    const fixture = databaseCapability(() =>
        join(root, "message-preferences.sqlite3"),
    );
    const snapshot = {
        hiddenContexts: { "ctx-legacy": true as const },
        orderByWorkspace: { "/workspace": ["alpha\u0000ctx-legacy"] },
        titles: { "alpha\u0000ctx-legacy": "Legacy title" },
        version: 1 as const,
        workspaceOrder: ["/workspace"],
    };
    const source = JSON.stringify(snapshot);
    await writeFile(legacy, source, "utf8");
    const first = new MessagePreferenceStore(legacy, fixture);
    assert.deepEqual(await first.read(), snapshot);
    await first.update({
        titles: { "alpha\u0000ctx-legacy": "Updated title" },
    });
    await first.close();
    assert.equal(await readFile(legacy, "utf8"), source);
    await assert.rejects(first.read(), /closed/u);
    const second = new MessagePreferenceStore(legacy, fixture);
    assert.equal(
        (await second.read()).titles["alpha\u0000ctx-legacy"],
        "Updated title",
    );
    await second.close();
});
