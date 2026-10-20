import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { editsPath, INBOX, mail, OUTBOX, diskMemory, ROOT, STATE } from "../helpers/DiskMemory.ts";

const options = {};

test("Memory init is idempotent for its owner and preserves arbitrary schema-less files across restart", options, async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    const selection = await service.init(f.owner, "receiver");
    await f.put(`${ROOT}/receiver/decisions.anything`, "# No imposed schema\n中文\n{incomplete JSON\n");
    await f.put(INBOX, "Original mailbox notes\n");
    assert.deepEqual(await service.init(f.owner, "receiver"), selection);
    await assert.rejects(service.init({ ...f.owner, ctxId: "successor" }, "receiver"), /already exists/u);
    await service.close();
    const recovered = f.newMailing();
    assert.deepEqual(await recovered.status(f.owner), selection);
    assert.equal(await f.read(`${ROOT}/receiver/decisions.anything`), "# No imposed schema\n中文\n{incomplete JSON\n");
    assert.equal(await f.read(INBOX), "Original mailbox notes\n");
    assert.deepEqual(await recovered.status({ ...f.owner, ctxId: "unrelated" }), {});
    assert.deepEqual(await recovered.list(f.target), { memories: ["receiver"] });
});

test("Memory inheritance transfers a live owner and release keeps files for the next Context", options, async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    await f.put(`${ROOT}/receiver/research.md`, "Keep original research\n");
    const successor = { ...f.owner, ctxId: "successor" };
    await service.inherit(successor, "receiver");
    assert.deepEqual(await service.status(f.owner), {});
    assert.equal((await service.status(successor)).name, "receiver");
    assert.deepEqual(await service.release(f.owner), {});
    assert.deepEqual(await service.release(successor), { released: "receiver" });
    await service.close();
    const recovered = f.newMailing();
    assert.deepEqual(await recovered.status(successor), {});
    await recovered.inherit(f.owner, "receiver");
    assert.equal(await f.read(`${ROOT}/receiver/research.md`), "Keep original research\n");
    assert.deepEqual(JSON.parse(await f.read(STATE)).bindings, { receiver: "owner" });
});

test("Concurrent disk-backed scans durably append once and SQLite delivery retains original comments after restart", options, async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    const original = "Private original\n{not a schema}\n# A heading";
    const privateComment = await f.comment.queue({ ctxId: "unrelated", text: original });
    const source = "Existing chat prose\n" + mail();
    await f.put(OUTBOX, source);
    await Promise.all(Array.from({ length: 12 }, () => service.scan(f.target)));
    assert.equal((await f.read(INBOX)).split("<!-- MAIL ID sender#2 -->").length - 1, 1);
    assert.equal((await f.read(`${ROOT}/mailing.md`)).split("<!-- MAIL ID sender#2 -->").length - 1, 1);
    assert.equal(await f.read(OUTBOX), source);
    assert.equal((await f.comment.list("owner")).length, 1);
    const delivered = await Promise.all(Array.from({ length: 6 }, (_, i) => f.comment.consumePending("owner", `call-${i}`)));
    assert.deepEqual(delivered.map((value) => value.messages.length).sort(), [0, 0, 0, 0, 0, 1]);
    await service.close();
    await f.restartComment();
    await f.newMailing().poll();
    assert.equal((await f.comment.list("owner")).length, 1);
    assert.equal((await f.comment.list("owner"))[0]!.status, "delivered");
    assert.deepEqual((await f.comment.list("unrelated")).map(({ id, text, status }) => ({ id, text, status })),
        [{ id: privateComment.id, text: original, status: "sent" }]);
    assert.equal(f.events.filter((event) => event === "context.message.delivered").length, 1);
    assert.deepEqual(f.errors, []);
});

test("A partially appended outbox is ignored until complete without consuming its mail identity", options, async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    const complete = mail("First publication", "Payload includes *** End Edit\nand unicode λ");
    const partial = complete.slice(0, complete.indexOf("<!-- MAIL END -->"));
    await f.put(OUTBOX, partial);
    await service.scan(f.target);
    assert.deepEqual(JSON.parse(await f.read(STATE)).accepted, {});
    assert.deepEqual(await f.comment.list("owner"), []);
    await appendFile(join(f.workspace, OUTBOX), "<!-- MAIL END -->\n");
    await service.scan(f.target);
    assert.equal(await f.read(OUTBOX), complete);
    assert.match(await f.read(INBOX), /Payload includes \*\*\* End Edit\nand unicode λ/u);
    assert.deepEqual(Object.keys(JSON.parse(await f.read(STATE)).accepted), ["sender#1"]);
    assert.equal((await f.comment.list("owner")).length, 1);
});

test("An interrupted inbox append replays the durable index and delivers once after service restart", options, async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    await f.put(OUTBOX, mail());
    f.setBeforeTool(async (name, input) => {
        if (name === "file_edit" && editsPath(input, INBOX)) {
            f.setBeforeTool(undefined);
            throw new Error("Injected disconnect before inbox edit");
        }
    });
    await assert.rejects(service.scan(f.target), /Injected disconnect/u);
    assert.deepEqual(JSON.parse(await f.read(STATE)).accepted, {});
    assert.match(await f.read(`${ROOT}/mailing.md`), /<!-- MAIL ID sender#1 -->/u);
    assert.deepEqual(await f.comment.list("owner"), []);
    await service.close();
    await f.newMailing().poll();
    assert.equal((await f.read(`${ROOT}/mailing.md`)).split("<!-- MAIL ID sender#1 -->").length - 1, 1);
    assert.equal((await f.read(INBOX)).split("<!-- MAIL ID sender#1 -->").length - 1, 1);
    assert.equal((await f.comment.list("owner")).length, 1);
    assert.deepEqual(JSON.parse(await f.read(STATE)).pendingNotices, {});
});

test("A failed Comment notification retries from disk while accepted mail and inbox remain unique", options, async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    await f.put(OUTBOX, mail());
    f.setBeforeNotice(async () => {
        f.setBeforeNotice(undefined);
        throw new Error("Injected Comment admission failure");
    });
    await service.scan(f.target);
    assert.equal(f.errors.length, 1);
    assert.match(String(f.errors[0]), /Injected Comment admission failure/u);
    assert.deepEqual(await f.comment.list("owner"), []);
    assert.deepEqual(Object.keys(JSON.parse(await f.read(STATE)).pendingNotices), ["sender#1:inbox:receiver"]);
    await service.close();
    const recovered = f.newMailing();
    await recovered.poll();
    await recovered.poll();
    assert.equal((await f.comment.list("owner")).length, 1);
    assert.equal((await f.read(INBOX)).split("<!-- MAIL ID sender#1 -->").length - 1, 1);
    assert.deepEqual(JSON.parse(await f.read(STATE)).pendingNotices, {});
});

test("Expired owners leave durable pending notices for inheritance without notifying irrelevant Contexts", options, async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    f.active.delete("owner");
    await service.retireContext("owner");
    await f.put(OUTBOX, mail());
    await service.scan(f.target);
    assert.deepEqual(await f.comment.list(), []);
    assert.equal(Object.keys(JSON.parse(await f.read(STATE)).pendingNotices).length, 1);
    await service.close();
    const recovered = f.newMailing();
    await recovered.inherit({ ...f.owner, ctxId: "successor" }, "receiver");
    const notices = await f.comment.list("successor");
    assert.deepEqual(notices.map(({ text }) => text), ["New Mail\nFrom: sender\nSubject: Durable subject", `Mailbox ready: ${f.workspace}/${INBOX}`]);
    assert.deepEqual(await f.comment.list("owner"), []);
    assert.deepEqual(await f.comment.list("unrelated"), []);
    assert.deepEqual(JSON.parse(await f.read(STATE)).pendingNotices, {});
    assert.match(await f.read(INBOX), /Original body α/u);
});

test("Simultaneous inheritance preserves one owner without copying or deleting original memory", options, async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    await f.put(`${ROOT}/receiver/notes.txt`, "Unstructured memory stays here\n");
    await Promise.all([service.inherit({ ...f.owner, ctxId: "successor" }, "receiver"),
        service.inherit({ ...f.owner, ctxId: "unrelated" }, "receiver")]);
    assert.deepEqual(await service.status({ ...f.owner, ctxId: "successor" }), {});
    assert.equal((await service.status({ ...f.owner, ctxId: "unrelated" })).name, "receiver");
    assert.deepEqual(JSON.parse(await f.read(STATE)).bindings, { receiver: "unrelated" });
    assert.equal(await f.read(`${ROOT}/receiver/notes.txt`), "Unstructured memory stays here\n");
    assert.deepEqual(await service.list(f.target), { memories: ["receiver"] });
});

test("A committed mailbox append with a lost response is replayed without duplicating its body", options, async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    await f.put(OUTBOX, mail());
    f.setAfterTool(async (name, input) => {
        if (name === "file_edit" && editsPath(input, INBOX) &&
            String((input as { changes: string }).changes).includes("*** Patch File:")) {
            f.setAfterTool(undefined);
            throw new Error("Lost response after durable inbox append");
        }
    });
    await assert.rejects(service.scan(f.target), /Lost response/u);
    assert.match(await f.read(INBOX), /Original body α/u);
    assert.deepEqual(JSON.parse(await f.read(STATE)).accepted, {});
    await service.close();
    await f.newMailing().poll();
    assert.equal((await f.read(INBOX)).split("Original body α").length - 1, 1);
    assert.equal((await f.comment.list("owner")).length, 1);
    assert.deepEqual(JSON.parse(await f.read(STATE)).pendingNotices, {});
});

test("Mailing close drains an admitted scan while rejecting new mutations deterministically", options, async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    await f.put(OUTBOX, mail());
    let signalReached!: () => void;
    const reached = new Promise<void>((resolve) => { signalReached = resolve; });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    f.setBeforeTool(async (name, input) => {
        if (name === "file_edit" && editsPath(input, INBOX)) {
            f.setBeforeTool(undefined);
            signalReached();
            await resumed;
        }
    });
    const scan = service.scan(f.target);
    await reached;
    const closed = service.close();
    await assert.rejects(service.init({ ...f.owner, ctxId: "successor" }, "new-memory"), /closed/u);
    resume();
    await scan;
    await closed;
    assert.equal((await f.comment.list("owner")).length, 1);
    await assert.rejects(service.scan(f.target), /closed/u);
    const state = await f.read(STATE);
    await service.poll();
    assert.equal(await f.read(STATE), state);
});

test("An invalid sender cannot prevent a separate valid sender from publishing or erase old chat prose", options, async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    const invalid = "Old sender discussion\n<!-- MAIL BEGIN -->\nTo: receiver\nSubject: duplicate\nSubject: invalid\n\nbody\n<!-- MAIL END -->\n";
    await f.put(OUTBOX, invalid);
    const validPath = `${ROOT}/z-valid/chat.md`;
    const source = "Old valid discussion\n" + mail("Independent sender", "Preserved valid body");
    await f.put(validPath, source);
    await service.scan(f.target);
    assert.equal(f.errors.length, 1);
    assert.match(String(f.errors[0]), /Invalid Mailing Outbox for sender/u);
    assert.equal(await f.read(OUTBOX), invalid);
    assert.equal(await f.read(validPath), source);
    assert.match(await f.read(INBOX), /Preserved valid body/u);
    assert.deepEqual((await f.comment.list("owner")).map(({ text }) => text), ["New Mail\nFrom: z-valid\nSubject: Independent sender"]);
});
