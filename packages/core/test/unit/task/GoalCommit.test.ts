import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { join } from "node:path";

import { GoalService } from "../../../src/task/goal/index.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

const eio = () => Object.assign(new Error("injected EIO"), { code: "EIO" });

async function fixture() {
    const root = await createTestTempDirectory("goal-uncertain-commit-");
    const filePath = join(root, "goals.json");
    const events: string[] = [];
    const service = new GoalService({
        appendEvent: async (_type, data) => {
            events.push((data as { ctxId: string }).ctxId);
        },
        filePath,
        instanceName: "alpha",
    });
    await service.manage("ctx-a", { action: "start", objective: "First" });
    return { root, filePath, events, service };
}

function restoreAfterTest(t: TestContext) {
    t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
    });
}

test("Goal directory sync failure preserves the committed Goal and subsequent writes", {
    skip: process.platform === "win32",
}, async (t) => {
    restoreAfterTest(t);
    const f = await fixture();
    const realOpen = fs.promises.open;
    t.mock.method(fs.promises, "open", async (...args: Parameters<typeof fs.promises.open>) => {
        if (args[0] === f.root && args[1] === "r") throw eio();
        return await realOpen(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(f.service.manage("ctx-b", { action: "start", objective: "Second" }), {
        code: "goal.commitDurabilityUnconfirmed",
        retryable: false,
        details: { committed: true, filePath: f.filePath, phase: "directory-sync" },
    });
    assert.equal((await f.service.read("ctx-b"))?.objective, "Second");
    assert.equal((await new GoalService({
        filePath: f.filePath, instanceName: "alpha", appendEvent: async () => undefined,
    }).read("ctx-b"))?.objective, "Second");
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await f.service.manage("ctx-c", { action: "start", objective: "Third" });
    assert.deepEqual(
        JSON.parse(await fs.promises.readFile(f.filePath, "utf8")).goals
            .map((goal: { createdByCtxId: string }) => goal.createdByCtxId),
        ["ctx-a", "ctx-b", "ctx-c"],
    );
    assert.deepEqual(f.events, ["ctx-a", "ctx-b", "ctx-c"]);
});

test("Goal rename that commits and then reports failure is visible once", async (t) => {
    restoreAfterTest(t);
    const f = await fixture();
    const realRename = fs.promises.rename;
    t.mock.method(fs.promises, "rename", async (...args: Parameters<typeof fs.promises.rename>) => {
        await realRename(...args);
        throw eio();
    });
    syncBuiltinESMExports();
    await assert.rejects(f.service.manage("ctx-b", { action: "start", objective: "Second" }), {
        code: "goal.commitDurabilityUnconfirmed",
        retryable: false,
        details: { committed: true, filePath: f.filePath, phase: "rename" },
    });
    assert.equal((await f.service.read("ctx-b"))?.objective, "Second");
    assert.deepEqual(f.events, ["ctx-a", "ctx-b"]);
});

test("Goal rename with no effect preserves the old state", async (t) => {
    restoreAfterTest(t);
    const f = await fixture();
    t.mock.method(fs.promises, "rename", async () => { throw eio(); });
    syncBuiltinESMExports();
    await assert.rejects(f.service.manage("ctx-b", { action: "start", objective: "Second" }), {
        code: "EIO",
    });
    assert.equal(await f.service.read("ctx-b"), undefined);
    assert.equal((await f.service.read("ctx-a"))?.objective, "First");
    assert.deepEqual(f.events, ["ctx-a"]);
});

test("Goal unknown rename blocks stale writers until disk can be reconciled", async (t) => {
    restoreAfterTest(t);
    const f = await fixture();
    const realRename = fs.promises.rename;
    const realRead = fs.readFileSync;
    let renamed = false;
    t.mock.method(fs.promises, "rename", async (...args: Parameters<typeof fs.promises.rename>) => {
        await realRename(...args);
        renamed = true;
        throw eio();
    });
    t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
        if (renamed && args[0] === f.filePath) throw eio();
        return realRead(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(f.service.manage("ctx-b", { action: "start", objective: "Second" }), {
        code: "goal.commitUncertain",
        retryable: false,
        details: { committed: "unknown", filePath: f.filePath, phase: "rename" },
    });
    await assert.rejects(f.service.manage("ctx-c", { action: "start", objective: "Third" }), {
        code: "control.invalidTarget",
    });
    assert.deepEqual(f.events, ["ctx-a"]);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await f.service.manage("ctx-c", { action: "start", objective: "Third" });
    assert.deepEqual(f.events, ["ctx-a", "ctx-b", "ctx-c"]);
    assert.equal((await f.service.read("ctx-b"))?.objective, "Second");
    assert.equal((await f.service.read("ctx-c"))?.objective, "Third");
});
