import assert from "node:assert/strict";
import test from "node:test";
import { realWorkerTestOptions } from "../../../../test/TestPlatformSupport.ts";
import { editsPath, INBOX, mail, OUTBOX, realMemory, STATE, workerBinary } from "../helpers/RealMemory.ts";

test("Real Rust IPC: SQLite producer identity survives notification commit followed by a lost Mailing ACK", realWorkerTestOptions(workerBinary), async (t) => {
    const f = await realMemory(t);
    const first = f.newMailing();
    await first.init(f.owner, "receiver");
    await f.put(OUTBOX, mail());
    f.setBeforeNotice(async () => {
        f.setBeforeNotice(undefined);
        f.setBeforeTool(async (name, input) => {
            if (name === "file_edit" && editsPath(input, STATE)) {
                f.setBeforeTool(undefined);
                throw new Error("Mailing ACK unavailable after SQLite commit");
            }
        });
    });
    await assert.rejects(first.scan(f.target), /Mailing ACK unavailable/u);
    const queued = (await f.comment.list("owner"))[0]!;
    assert.equal(Object.keys(JSON.parse(await f.read(STATE)).pendingNotices).length, 1);
    await first.close();
    await f.restartComment();
    const next = f.newMailing();
    await next.poll();
    await next.poll();
    assert.deepEqual((await f.comment.list("owner")).map(({ id, text }) => ({ id, text })),
        [{ id: queued.id, text: "New Mail\nFrom: sender\nSubject: Durable subject" }]);
    assert.equal((await f.read(INBOX)).split("Original body α").length - 1, 1);
    assert.deepEqual(JSON.parse(await f.read(STATE)).pendingNotices, {});
    assert.deepEqual(f.errors, []);
});
