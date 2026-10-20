import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { CommentService, type CommentServiceOptions } from "../../src/comment/CommentService.ts";
import { MessageStore } from "../../src/message/store/MessageStore.ts";
import { databaseConnection } from "../helpers/Database.ts";

async function fixture(t: test.TestContext, appendEvent: CommentServiceOptions["appendEvent"] = async () => {}, instanceName = "crash-fixture") {
    const root = await createTestTempDirectory("round4-comment-lifetime");
    const filePath = join(root, "messages.sqlite3");
    const store = new MessageStore({ filePath, instanceName,
        openDatabase: () => databaseConnection(filePath) });
    t.after(() => store.close());
    return { filePath, store, service: new CommentService({ store, instanceName, appendEvent }) };
}

for (const boundary of ["queued", "delivered"] as const) {
    test(`SQLite survives a real process exit immediately after ${boundary} commit with original text intact`, async (t) => {
        const f = await fixture(t);
        const child = spawn(process.execPath, ["--import", "tsx", "--import",
            fileURLToPath(new URL("../RegisterWorkspacePackages.mjs", import.meta.url)),
            fileURLToPath(new URL("../helpers/CommentCrashProcess.ts", import.meta.url)), f.filePath, boundary],
        { stdio: "ignore", timeout: 20_000, env: { ...process.env,
            TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../../tsconfig.test.json", import.meta.url)) } });
        const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code, signal) => resolve({ code, signal }));
        });
        assert.equal(result.signal, null);
        assert.equal(result.code, boundary === "queued" ? 23 : 24);
        const records = await f.service.list("shared-context");
        assert.equal(records.length, 1);
        assert.equal(records[0]!.text, "Original crash-boundary comment\nUnicode λ\n{plain prose");
        assert.equal(records[0]!.status, boundary === "queued" ? "sent" : "delivered");
        const delivery = await f.service.consumePending("shared-context", "recovery-call");
        assert.equal(delivery.messages.length, boundary === "queued" ? 1 : 0);
        assert.deepEqual((await f.service.consumePending("shared-context", "retry-call")).messages, []);
        assert.equal((await f.service.list("shared-context"))[0]!.status, "delivered");
    });
}

test("Retirement drains admitted writers, fails their pending records durably, and rejects subsequent work", async (t) => {
    let signalReached!: () => void;
    const reached = new Promise<void>((resolve) => { signalReached = resolve; });
    let release!: () => void;
    const resumed = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture(t, async (type) => {
        if (type === "context.message.queued") {
            signalReached();
            await resumed;
        }
    });
    const first = f.service.queue({ ctxId: "ctx", text: "#stop Original instruction" });
    await reached;
    const second = f.service.queue({ ctxId: "ctx", text: "Second admitted writer" });
    const retirement = f.service.retire("Context expired");
    await assert.rejects(f.service.queue({ ctxId: "ctx", text: "Too late" }), /not found or is disabled/u);
    release();
    const records = await Promise.all([first, second]);
    await retirement;
    await f.store.close();
    const recovered = new CommentService({ store: f.store, instanceName: "crash-fixture", appendEvent: async () => {} });
    assert.deepEqual((await recovered.list("ctx")).map(({ id, text, status, error }) => ({ id, text, status, error })),
        records.map(({ id, text }) => ({ id, text, status: "failed", error: "Context expired" })));
    assert.deepEqual(await f.store.readControlState("ctx"), {});
    assert.deepEqual((await recovered.consumePending("ctx", "after-expiry")).messages, []);
});

test("One Context on separate Instance databases keeps control state and original text isolated", async (t) => {
    const left = await fixture(t, undefined, "alpha");
    const right = await fixture(t, undefined, "beta");
    const stop = await left.service.queue({ ctxId: "same-context", text: "#stop Left original" });
    await right.service.queue({ ctxId: "same-context", text: "#resume Right original" });
    assert.deepEqual(await left.service.reviewToolCall("same-context", "file_read", "left-call"),
        { kind: "stop", commentId: stop.id, comment: stop.text });
    await right.service.consumePending("same-context", "same-call");
    assert.deepEqual(await right.service.reviewToolCall("same-context", "file_read"), { kind: "allow" });
    await Promise.all([left.store.close(), right.store.close()]);
    assert.deepEqual(await left.service.reviewToolCall("same-context", "file_read"), { kind: "stop", commentId: stop.id });
    assert.deepEqual((await right.service.list("same-context")).map(({ instance, text }) => ({ instance, text })),
        [{ instance: "beta", text: "#resume Right original" }]);
    assert.deepEqual((await left.service.list("same-context")).map(({ instance, text }) => ({ instance, text })),
        [{ instance: "alpha", text: "#stop Left original" }]);
});

test("SQLite failure on the second delivery rolls back every Comment and control directive before retry", async (t) => {
    const f = await fixture(t);
    const first = await f.service.queue({ ctxId: "rollback-context", text: "#stop Original stop" });
    const second = await f.service.queue({ ctxId: "rollback-context", text: "#resume Original resume" });
    const before = await f.store.readControlState("rollback-context");
    const database = await databaseConnection(f.filePath);
    t.after(() => database.close());
    await database.exec(`CREATE TRIGGER reject_second_delivery BEFORE UPDATE OF status ON message_entries
        WHEN OLD.id = '${second.id}' AND NEW.status = 'delivered'
        BEGIN SELECT RAISE(ABORT, 'Injected second-row SQLite failure'); END`);
    await assert.rejects(f.service.consumePending("rollback-context", "failed-transaction"), /Injected second-row SQLite failure/u);
    await f.store.close();
    assert.deepEqual((await f.service.list("rollback-context")).map(({ id, status, callId }) => ({ id, status, callId })), [
        { id: first.id, status: "sent", callId: undefined },
        { id: second.id, status: "sent", callId: undefined },
    ]);
    assert.deepEqual(await f.store.readControlState("rollback-context"), before);
    await database.exec("DROP TRIGGER reject_second_delivery");
    assert.deepEqual((await f.service.consumePending("rollback-context", "successful-retry")).messages.map(({ id, text }) => ({ id, text })),
        [first, second].map(({ id, text }) => ({ id, text })));
    assert.deepEqual(await f.service.reviewToolCall("rollback-context", "file_read"), { kind: "allow" });
    assert.deepEqual((await f.service.consumePending("rollback-context", "duplicate-retry")).messages, []);
});
