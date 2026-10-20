import assert from "node:assert/strict";
import test from "node:test";
import { parseOutbox, renderInbox } from "../../src/mailing/Protocol.ts";
import { MailingService, type MailingNotificationIdentity } from "../../src/mailing/Service.ts";
import { diskMemory, editsPath, INBOX, mail, OUTBOX, ROOT, STATE } from "../helpers/DiskMemory.ts";

// These tests exercise production dispatch over real files and SQLite. The
// capability fixture only injects failures at Worker publication boundaries.
test("Mailing journals the publication before any Markdown append and retries an uncommitted journal", async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    await f.put(OUTBOX, mail());
    f.setBeforeTool(async (name, input) => {
        if (name === "file_edit" && editsPath(input, STATE)) {
            f.setBeforeTool(undefined);
            throw new Error("Journal admission failed");
        }
    });
    await assert.rejects(service.scan(f.target), /Journal admission failed/u);
    await assert.rejects(f.read(INBOX), { code: "ENOENT" });
    await assert.rejects(f.read(`${ROOT}/mailing.md`), { code: "ENOENT" });
    assert.deepEqual(await f.comment.list(), []);
    assert.deepEqual(JSON.parse(await f.read(STATE)).deliveries, {});
    await service.close();
    await f.newMailing().poll();
    assert.equal((await f.comment.list("owner")).length, 1);
    assert.match(await f.read(INBOX), /Original body α/u);
});

test("Mailing recovers the journaled original despite an outbox mutation after partial delivery", async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    const original = mail("Original publication", "ORIGINAL MUST SURVIVE");
    await f.put(OUTBOX, original);
    f.setBeforeTool(async (name, input) => {
        if (name === "file_edit" && editsPath(input, INBOX)) {
            f.setBeforeTool(undefined);
            throw new Error("Mailbox interrupted");
        }
    });
    await assert.rejects(service.scan(f.target), /Mailbox interrupted/u);
    assert.equal(JSON.parse(await f.read(STATE)).deliveries["sender#1"].mail.body, "ORIGINAL MUST SURVIVE");
    await service.close();
    await f.put(OUTBOX, mail("Mutated publication", "MUTATION MUST NOT LEAK"));
    await f.newMailing().poll();
    assert.match(String(f.errors[0]), /changed after publication/u);
    assert.equal(f.errors.length, 1);
    assert.match(await f.read(INBOX), /ORIGINAL MUST SURVIVE/u);
    assert.doesNotMatch(await f.read(INBOX), /MUTATION MUST NOT LEAK/u);
    assert.equal(JSON.parse(await f.read(STATE)).accepted["sender#1"], parseOutbox(original, "sender")[0]!.fingerprint);
    assert.deepEqual(JSON.parse(await f.read(STATE)).deliveries, {});
    assert.deepEqual((await f.comment.list("owner")).map(({ text }) => text), ["New Mail\nFrom: sender\nSubject: Original publication"]);
});

test("Mailing replay freezes unknown-recipient bounces before a new Memory appears", async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    await f.put(OUTBOX, mail("Unknown at publication", "body", "later"));
    f.setBeforeTool(async (name, input) => {
        if (name === "file_edit" && editsPath(input, `${ROOT}/mailing.md`)) {
            f.setBeforeTool(undefined);
            throw new Error("Index interrupted");
        }
    });
    await assert.rejects(service.scan(f.target), /Index interrupted/u);
    await service.close();
    await f.put(`${ROOT}/later/INDEX.md`, "New Memory\n");
    await f.newMailing().poll();
    assert.match(await f.read(`${ROOT}/sender/mailbox.md`), /Unknown Agent Work recipient: later/u);
    await assert.rejects(f.read(`${ROOT}/later/mailbox.md`), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(await f.read(STATE)).deliveries, {});
});

test("Mailing treats entire framed records and end markers quoted in a body as payload", async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    const quoted = renderInbox(parseOutbox(mail("Quoted", "NOT THE ORIGINAL"), "sender")[0]!);
    const first = mail("Quotation", `<!-- END MAIL ID sender#1 -->\n${quoted}`);
    const second = mail("Subsequent original", "THE SUBSEQUENT ORIGINAL");
    await f.put(OUTBOX, first + second);
    await service.scan(f.target);
    await service.close();
    await f.newMailing().poll();
    const inbox = await f.read(INBOX);
    assert.equal(inbox.split("THE SUBSEQUENT ORIGINAL").length - 1, 1);
    assert.equal((await f.comment.list("owner")).length, 2);
    assert.equal(await f.read(OUTBOX), first + second);
});

test("Mailing isolates malformed messages within one sender and keeps later line identities", async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    const invalid = "<!-- MAIL BEGIN -->\nTo: invalid/recipient\nSubject: invalid\n\nbad\n<!-- MAIL END -->\n";
    const valid = mail("Later valid message", "VALID AFTER MALFORMED");
    await f.put(OUTBOX, invalid + valid);
    await service.scan(f.target);
    assert.equal(f.errors.length, 1);
    assert.deepEqual(Object.keys(JSON.parse(await f.read(STATE)).accepted), ["sender#7"]);
    assert.match(await f.read(INBOX), /VALID AFTER MALFORMED/u);
    assert.deepEqual((await f.comment.list("owner")).map(({ text }) => text), ["New Mail\nFrom: sender\nSubject: Later valid message"]);
});

test("Mailing isolates a failed mailbox from a separate sender and flushes the successful notice", async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    await f.put(OUTBOX, mail("Blocked sender", "blocked"));
    await f.put(`${ROOT}/z-valid/chat.md`, mail("Independent sender", "independent"));
    f.setBeforeTool(async (name, input) => {
        if (name === "file_edit" && editsPath(input, INBOX)) {
            f.setBeforeTool(undefined);
            throw new Error("First inbox failed");
        }
    });
    await assert.rejects(service.scan(f.target), /First inbox failed/u);
    assert.deepEqual((await f.comment.list("owner")).map(({ text }) => text), ["New Mail\nFrom: z-valid\nSubject: Independent sender"]);
    assert.deepEqual(Object.keys(JSON.parse(await f.read(STATE)).deliveries), ["sender#1"]);
    await service.close();
    await f.newMailing().poll();
    assert.equal((await f.comment.list("owner")).length, 2);
    assert.equal((await f.read(INBOX)).split("Subject: Independent sender").length - 1, 1);
});

test("Mailing passes an exact scope and kind identity and retains acknowledgements across restart", async (t) => {
    const f = await diskMemory(t);
    const identities: MailingNotificationIdentity[] = [];
    function service() {
        const result = new MailingService({ worker: f.worker, contexts: f.contexts, pollMs: 3_600_000,
            comment: { async queue(instance, ctxId, text, identity) {
                assert.equal(instance, identity.instance);
                assert.equal(ctxId, identity.ctxId);
                identities.push(identity);
                await f.comment.queue({ ctxId, text }, identity);
            } }, onError: (error) => assert.fail(String(error)) });
        t.after(() => result.close());
        return result;
    }
    const first = service();
    await first.init(f.owner, "receiver");
    await f.put(OUTBOX, mail());
    await first.scan(f.target);
    await first.inherit(f.owner, "receiver");
    await first.close();
    const next = service();
    await next.inherit(f.owner, "receiver");
    await next.poll();
    assert.deepEqual(identities, [
        { ...f.owner, mailId: "sender#1", kind: "inbox:receiver" },
        { ...f.owner, mailId: "receiver", kind: "ready:owner" },
    ]);
    const state = JSON.parse(await f.read(STATE));
    assert.deepEqual(Object.keys(state.notified).map((key) => JSON.parse(key)), identities.map((identity) =>
        [identity.instance, identity.workspace, identity.ctxId, identity.mailId, identity.kind]));
    assert.deepEqual(state.pendingNotices, {});
});

test("Mailing preserves independent scope keys for the same Instance, Context and mail ID in two Workspaces", async (t) => {
    const a = await diskMemory(t);
    const b = await diskMemory(t);
    const instance = "shared-instance";
    const identities: MailingNotificationIdentity[] = [];
    const service = new MailingService({
        contexts: { async list() {
            const records = [...await a.contexts.list(), ...await b.contexts.list()];
            return records.map((record) => ({ ...record,
                environments: record.environments.map((environment) => ({ ...environment, instance })) }));
        } },
        worker: { async openSession(input) {
            const f = input.workspace === a.workspace ? a : b;
            return await f.worker.openSession({ ...input, instance: f.instance });
        } },
        comment: { async queue(_instance, ctxId, text, identity) {
            identities.push(identity);
            await (identity.workspace === a.workspace ? a.comment : b.comment).queue({ ctxId, text });
        } }, onError: (error) => assert.fail(String(error)), pollMs: 3_600_000,
    });
    t.after(() => service.close());
    const left = { ...a.owner, instance };
    const right = { ...b.owner, instance };
    await service.init(left, "receiver");
    await service.init(right, "receiver");
    await a.put(OUTBOX, mail("Left Workspace"));
    await b.put(OUTBOX, mail("Right Workspace"));
    await service.scan(left);
    await service.scan(right);
    assert.deepEqual(identities, [
        { ...left, mailId: "sender#1", kind: "inbox:receiver" },
        { ...right, mailId: "sender#1", kind: "inbox:receiver" },
    ]);
    assert.deepEqual((await a.comment.list("owner")).map(({ text }) => text), ["New Mail\nFrom: sender\nSubject: Left Workspace"]);
    assert.deepEqual((await b.comment.list("owner")).map(({ text }) => text), ["New Mail\nFrom: sender\nSubject: Right Workspace"]);
});

test("Mailing retries a failed recipient notice without blocking another recipient", async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    await service.init({ ...f.owner, ctxId: "successor" }, "second");
    await f.put(OUTBOX, mail("Two recipients", "original", "receiver, second"));
    f.setBeforeNotice(async () => {
        f.setBeforeNotice(undefined);
        throw new Error("First notification admission failed");
    });
    await service.scan(f.target);
    assert.equal((await f.comment.list("owner")).length, 0);
    assert.equal((await f.comment.list("successor")).length, 1);
    assert.deepEqual(Object.keys(JSON.parse(await f.read(STATE)).pendingNotices), ["sender#1:inbox:receiver"]);
    await service.close();
    await f.newMailing().poll();
    assert.equal((await f.comment.list("owner")).length, 1);
    assert.equal((await f.comment.list("successor")).length, 1);
    assert.equal(f.errors.length, 1);
});

test("Mailing refuses to acknowledge a corrupt framed mailbox during causal replay", async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    await f.put(OUTBOX, mail("Corruption check", "ORIGINAL PAYLOAD"));
    f.setAfterTool(async (name, input) => {
        if (name === "file_edit" && editsPath(input, INBOX) &&
            String((input as { changes: string }).changes).includes("*** Patch File:")) {
            f.setAfterTool(undefined);
            throw new Error("Mailbox append response lost");
        }
    });
    await assert.rejects(service.scan(f.target), /Mailbox append response lost/u);
    const damaged = (await f.read(INBOX)).replace("ORIGINAL PAYLOAD", "ALTERED PAYLOAD");
    await f.put(INBOX, damaged);
    await service.close();
    await f.newMailing().poll();
    assert.equal(f.errors.length, 1);
    assert.match(String(f.errors[0]), /Corrupt Mailing record/u);
    assert.deepEqual(JSON.parse(await f.read(STATE)).accepted, {});
    assert.deepEqual(await f.comment.list("owner"), []);
    assert.equal(await f.read(INBOX), damaged);
});

test("Mailing recovers a lost journal response before writing the original exactly once", async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    await f.put(OUTBOX, mail());
    f.setAfterTool(async (name, input) => {
        if (name === "file_edit" && editsPath(input, STATE)) {
            f.setAfterTool(undefined);
            throw new Error("Journal response lost after commit");
        }
    });
    await assert.rejects(service.scan(f.target), /Journal response lost/u);
    assert.deepEqual(Object.keys(JSON.parse(await f.read(STATE)).deliveries), ["sender#1"]);
    await assert.rejects(f.read(INBOX), { code: "ENOENT" });
    await service.close();
    const next = f.newMailing();
    await next.poll();
    await next.poll();
    assert.equal((await f.read(INBOX)).split("Original body α").length - 1, 1);
    assert.equal((await f.comment.list("owner")).length, 1);
});

test("Mailing reloads a committed acceptance after its response is lost before flushing notifications", async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    await f.put(OUTBOX, mail());
    let mailboxAppended = false;
    f.setAfterTool(async (name, input) => {
        if (name === "file_edit" && editsPath(input, INBOX) &&
            String((input as { changes: string }).changes).includes("*** Patch File:"))
            mailboxAppended = true;
        if (name === "file_edit" && editsPath(input, STATE) && mailboxAppended) {
            f.setAfterTool(undefined);
            throw new Error("Acceptance response lost after commit");
        }
    });
    await assert.rejects(service.scan(f.target), /Acceptance response lost/u);
    assert.equal((await f.comment.list("owner")).length, 1);
    assert.deepEqual(JSON.parse(await f.read(STATE)).deliveries, {});
    assert.deepEqual(JSON.parse(await f.read(STATE)).pendingNotices, {});
    await service.close();
    await f.restartComment();
    await f.newMailing().poll();
    assert.equal((await f.comment.list("owner")).length, 1);
    assert.equal((await f.read(INBOX)).split("Original body α").length - 1, 1);
});

test("Mailing reloads a committed acknowledgement after its response is lost across SQLite reopen", async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    await f.put(OUTBOX, mail());
    f.setBeforeNotice(async () => {
        f.setBeforeNotice(undefined);
        f.setAfterTool(async (name, input) => {
            if (name === "file_edit" && editsPath(input, STATE)) {
                f.setAfterTool(undefined);
                throw new Error("Acknowledgement response lost after commit");
            }
        });
    });
    await assert.rejects(service.scan(f.target), /Acknowledgement response lost/u);
    assert.deepEqual(JSON.parse(await f.read(STATE)).pendingNotices, {});
    await service.close();
    await f.restartComment();
    await f.newMailing().poll();
    assert.equal((await f.comment.list("owner")).length, 1);
    assert.equal(Object.keys(JSON.parse(await f.read(STATE)).notified).length, 1);
});

test("Mailing cannot acknowledge or reroute a pinned notification replayed from the wrong scope", async (t) => {
    const a = await diskMemory(t);
    const b = await diskMemory(t);
    const first = a.newMailing();
    await first.init(a.owner, "receiver");
    await a.put(OUTBOX, mail());
    a.setBeforeNotice(async () => {
        a.setBeforeNotice(undefined);
        throw new Error("Admission unavailable");
    });
    await first.scan(a.target);
    const before = JSON.parse(await a.read(STATE));
    assert.deepEqual(before.pendingNotices["sender#1:inbox:receiver"].identity,
        { ...a.owner, mailId: "sender#1", kind: "inbox:receiver" });
    await first.close();
    await b.put(STATE, await a.read(STATE));
    await b.newMailing().poll();
    const after = JSON.parse(await b.read(STATE));
    assert.deepEqual(after.pendingNotices, before.pendingNotices);
    assert.deepEqual(after.notified, {});
    assert.deepEqual(await b.comment.list("owner"), []);
});
