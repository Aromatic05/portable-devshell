import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContextObserveCapability } from "@portable-devshell/extension/context";
import { MailingService } from "../../src/mailing/Service.ts";
import { parseOutbox } from "../../src/mailing/Protocol.ts";
import { diskMemory, editsPath, INBOX, mail, OUTBOX, ROOT, STATE } from "../helpers/DiskMemory.ts";

// Deliberately outside test/unit/*.test.ts. These assertions express the desired
// invariant and must remain red until the production defect is fixed.
test("R4-D1: a notification committed to SQLite must not duplicate after its Mailing acknowledgement is lost", async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    await f.put(OUTBOX, mail());
    f.setBeforeNotice(async () => {
        f.setBeforeNotice(undefined);
        f.setBeforeTool(async (name, input) => {
            if (name === "file_edit" && editsPath(input, STATE)) {
                f.setBeforeTool(undefined);
                throw new Error("Crash after SQLite notification commit, before Mailing acknowledgement");
            }
        });
    });
    await assert.rejects(service.scan(f.target), /Crash after SQLite/u);
    assert.equal((await f.comment.list("owner")).length, 1);
    assert.equal(Object.keys(JSON.parse(await f.read(STATE)).pendingNotices).length, 1);
    await service.close();
    await f.restartComment();
    await f.newMailing().poll();
    assert.equal((await f.read(INBOX)).split("<!-- MAIL ID sender#1 -->").length - 1, 1);
    assert.equal((await f.comment.list("owner")).length, 1,
        "One durable mail must produce one durable notification across service and SQLite reopen");
});

test("R4-D2: one Context on two Instances must receive both scope-local mail notifications", async (t) => {
    const a = await diskMemory(t);
    const b = await diskMemory(t);
    const contexts = { async list(query?: { instance?: string }) {
        const left = await a.contexts.list(query);
        const right = await b.contexts.list(query);
        return [...left, ...right];
    } } as ExtensionContextObserveCapability;
    const service = new MailingService({
        contexts, pollMs: 3_600_000,
        worker: { openSession: (input) => (input.instance === a.instance ? a.worker : b.worker).openSession(input) },
        comment: { async queue(instance, ctxId, text) {
            await (instance === a.instance ? a.comment : b.comment).queue({ ctxId, text });
        } }, onError: (error) => assert.fail(String(error)),
    });
    t.after(() => service.close());
    await service.init(a.owner, "receiver");
    await service.init(b.owner, "receiver");
    await a.put(OUTBOX, mail("Instance A"));
    await b.put(OUTBOX, mail("Instance B"));
    await service.scan(a.target);
    await service.scan(b.target);
    assert.match(await b.read(INBOX), /Subject: Instance B/u);
    assert.deepEqual(JSON.parse(await b.read(STATE)).pendingNotices, {});
    assert.deepEqual((await a.comment.list("owner")).map(({ text }) => text), ["New Mail\nFrom: sender\nSubject: Instance A"]);
    assert.deepEqual((await b.comment.list("owner")).map(({ text }) => text), ["New Mail\nFrom: sender\nSubject: Instance B"],
        "Scope B must not acknowledge a notification merely because scope A used the same mail ID and Context");
});

test("R4-D3: quoted mail markers in an earlier body must not suppress a subsequent original message", async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    const first = mail("Marker quote", "Visible prose\n<!-- MAIL ID sender#8 -->");
    const second = mail("Real subsequent mail", "SECOND ORIGINAL MESSAGE MUST BE PRESENT");
    const source = first + second;
    assert.deepEqual(parseOutbox(source, "sender").map(({ id }) => id), ["sender#1", "sender#8"]);
    await f.put(OUTBOX, source);
    await service.scan(f.target);
    assert.equal(Object.keys(JSON.parse(await f.read(STATE)).accepted).length, 2);
    assert.equal((await f.comment.list("owner")).length, 2);
    assert.equal(await f.read(OUTBOX), source);
    assert.match(await f.read(INBOX), /SECOND ORIGINAL MESSAGE MUST BE PRESENT/u,
        "Acknowledged mail cannot be replaced by a marker quoted in another message");
});

test("R4-D4: stale accepted outbox mutation must not starve another sender's durable notification", async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    f.active.delete("owner");
    await f.put(OUTBOX, mail("Previously accepted"));
    await service.scan(f.target);
    await f.put(OUTBOX, mail("Illegally mutated old message"));
    await mkdir(join(f.workspace, ROOT, "z-sender"));
    await f.put(`${ROOT}/z-sender/chat.md`, mail("Independent valid message", "Valid original"));
    f.active.add("owner");
    // poll deliberately catches scan failures through the production onError path.
    await service.poll();
    assert.equal(f.errors.length, 1);
    assert.match(String(f.errors[0]), /changed after publication/u);
    assert.deepEqual((await f.comment.list("owner")).map(({ text }) => text), [
        "New Mail\nFrom: sender\nSubject: Previously accepted",
        "New Mail\nFrom: z-sender\nSubject: Independent valid message",
    ], "One invalid sender must not starve all pending notices and unrelated senders");
});
