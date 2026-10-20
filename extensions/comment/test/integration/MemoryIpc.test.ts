import assert from "node:assert/strict";
import test from "node:test";
import { realWorkerTestOptions } from "../../../../test/TestPlatformSupport.ts";
import { INBOX, mail, OUTBOX, realMemory, STATE, workerBinary } from "../helpers/RealMemory.ts";

// Explicit integration target: excluded from the package's unit/*.test.ts glob.
// No in-memory or disk capability substitute is selected when IPC is unavailable.
test("Real Rust IPC: Memory inheritance, mail append, SQLite notification and restart dedup", realWorkerTestOptions(workerBinary), async (t) => {
    const f = await realMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    await f.put(OUTBOX, mail());
    await Promise.all(Array.from({ length: 8 }, () => service.scan(f.target)));
    assert.equal((await f.read(INBOX)).split("<!-- MAIL ID sender#1 -->").length - 1, 1);
    const notices = await f.comment.list("owner");
    assert.equal(notices.length, 1);
    assert.deepEqual((await f.comment.consumePending("owner", "delivered")).messages.map(({ id }) => id), [notices[0]!.id]);
    await service.close();
    await f.restartComment();
    const recovered = f.newMailing();
    await recovered.poll();
    assert.equal((await f.comment.list("owner")).length, 1);
    await recovered.inherit({ ...f.owner, ctxId: "successor" }, "receiver");
    assert.deepEqual(await recovered.status(f.owner), {});
    assert.equal((await recovered.status({ ...f.owner, ctxId: "successor" })).name, "receiver");
    assert.deepEqual(JSON.parse(await f.read(STATE)).pendingNotices, {});
    assert.deepEqual(f.errors, []);
});
