import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContextObserveCapability } from "@portable-devshell/extension/context";
import type { ExtensionWorkerExecuteCapability, ExtensionWorkerOpenInput } from "@portable-devshell/extension/worker";
import type { CliModelCommandInvocationContext, CliNativeCommandInvocationContext } from "@portable-devshell/extension/cli";
import { createMailingHook, createMemoryAutoHook } from "../../src/mailing/Hook.ts";
import { executeMemoryModelCommand, executeMemoryNativeCommand } from "../../src/mailing/Command.ts";
import { MailingService } from "../../src/mailing/Service.ts";
import { parseOutbox, taskName } from "../../src/mailing/Protocol.ts";

test("Mailing Hook never adds instructions to environ_info", async () => {
    const hook = createMailingHook({ scan: async () => {} }, () => {});
    const input = {
        callId: "call-bootstrap",
        direction: "outbound" as const,
        value: {
            context: { instance: "demo", source: "mcp" as const },
            kind: "result" as const,
            toolName: "environ_info",
            payload: { comment: ["Memory 未初始化。执行 devshell memory init <name>。"] },
        },
    };
    const result = await hook(input, {} as never);
    assert.deepEqual(result.payload, input.value.payload);
});

const A = "file-panel-unify";
const B = "stage-event-architecture";
const instance = "testspace";
const workspace = "/testspace/workspace";
const root = "var/agent-work/";
const outbox = root + A + "/chat.md";
const inbox = root + B + "/mailbox.md";
const index = root + "mailing.md";

function mail(subject: string, body: string, to = B): string {
    return [
        "<!-- MAIL BEGIN -->", "To: " + to, "Subject: " + subject,
        "", body, "<!-- MAIL END -->", "",
    ].join("\n");
}

type Row = Record<string, unknown>;

class FakeWorkspace {
    readonly files = new Map<string, string>();
    readonly calls: string[] = [];
    readonly globDepths: number[] = [];
    failAppendOnceOn?: string;
    beforeEdit?: (path: string) => void;

    constructor() {
        this.files.set(root + A + "/INDEX.md", "# " + A + "\n");
        this.files.set(root + B + "/INDEX.md", "# " + B + "\n");
    }

    async callTool(name: string, raw: unknown): Promise<Row> {
        const input = raw as Row;
        this.calls.push(name);
        if (name === "file_glob") {
            this.globDepths.push(Number(input.maxDepth ?? 0));
            if (input.type === "file")
                return { entries: [...this.files.keys()].filter((name) => name.endsWith("/chat.md"))
                    .map((path) => ({ path: "./" + path, type: "file" })) };
            const paths = new Set<string>();
            for (const path of this.files.keys()) {
                const match = /^var\/agent-work\/([^/]+)\//u.exec(path);
                if (match) paths.add("./var/agent-work/" + match[1]);
            }
            return { entries: [...paths].map((path) => ({ path, type: "directory" })) };
        }
        if (name === "file_read") {
            const request = (input.files as Array<{ path: string }>)[0]!;
            const text = this.files.get(request.path);
            if (text === undefined) return {
                files: [{ path: request.path, error: { code: "file.notFound", message: "missing" } }],
            };
            const content = text.replace(/\n$/u, "").split("\n")
                .map((line, i) => String(i + 1) + ":" + line).join("\n");
            return { files: [{ path: request.path, view: "content", content }] };
        }
        if (name === "file_edit") {
            const changes = String(input.changes);
            const lines = changes.split("\n");
            assert.equal(lines[0], "*** Begin Edit");
            assert.equal(lines.at(-1), "*** End Edit");
            const header = /^(\*\*\* (?:Write|Rewrite|Patch) File): (.+)$/u.exec(lines[1]!);
            assert.ok(header, "unexpected file_edit: " + changes);
            const path = header[2]!;
            this.beforeEdit?.(path);
            if (this.failAppendOnceOn === path) {
                this.failAppendOnceOn = undefined;
                throw new Error("simulated Worker disconnect");
            }
            const body = lines.slice(2, -1);
            if (header[1] === "*** Patch File") {
                assert.equal(body[0], "@@ EOF");
                assert.ok(this.files.has(path));
                assert.ok(body.slice(1).every((line) => line.startsWith("+")));
                this.files.set(path, this.files.get(path)! +
                    body.slice(1).map((line) => line.slice(1)).join("\n") + "\n");
            } else {
                if (header[1] === "*** Write File") assert.equal(this.files.has(path), false);
                if (header[1] === "*** Rewrite File") assert.equal(this.files.has(path), true);
                this.files.set(path, body.join("\n") + "\n");
            }
            return { operations: [{ path, status: "applied" }] };
        }
        throw new Error("Unsupported Worker tool: " + name);
    }
}

function fixture() {
    const fs = new FakeWorkspace();
    const openedTargets: ExtensionWorkerOpenInput[] = [];
    const active = new Set(["ctx-a", "ctx-b", "ctx-c"]);
    const notices: Array<{ ctxId: string; message: string }> = [];
    const errors: unknown[] = [];
    let failNextNotice = false;
    const contexts = {
        async list(query?: { instance?: string; workspace?: string }) {
            if (query?.instance && query.instance !== instance) return [];
            if (query?.workspace && query.workspace !== workspace) return [];
            return [...active].map((ctxId) => ({
                ctxId, status: "active",
                createdAt: "2026-10-12T00:00:00Z",
                lastAccessedAt: "2026-10-12T00:00:00Z",
                expiresAt: "2026-10-13T00:00:00Z",
                environments: [{ instance, workspace }],
            }));
        },
    } as ExtensionContextObserveCapability;
    const worker = {
        async openSession(target: ExtensionWorkerOpenInput) {
            assert.equal(target.instance, instance);
            assert.equal(target.workspace, workspace);
            openedTargets.push({ ...target });
            return {
                instance, workspace,
                environment: { homeDirectory: "/testspace", platform: { arch: "x64", os: "linux" } },
                closed: new Promise<void>(() => undefined),
                listTools: () => [],
                callTool: (name: string, params: unknown) => fs.callTool(name, params),
                close: async () => undefined,
            };
        },
    } as ExtensionWorkerExecuteCapability;
    const mailing = new MailingService({
        worker, contexts,
        comment: { async queue(_instance, ctxId, message) {
            if (failNextNotice) {
                failNextNotice = false;
                throw new Error("simulated Comment queue failure");
            }
            notices.push({ ctxId, message });
        } },
        onError(error) { errors.push(error); },
        pollMs: 3_600_000,
    });
    return {
        fs, notices, errors, active, mailing, worker, contexts, openedTargets,
        failNoticeOnce() { failNextNotice = true; },
    };
}

test("Mailing parses complete messages only and validates Agent Work identity", () => {
    const source = "Old chat prose\n" + mail("Ready", "The body") +
        mail("Pending", "unfinished").replace("<!-- MAIL END -->", "");
    const parsed = parseOutbox(source, A);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.from, A);
    assert.equal(parsed[0]!.subject, "Ready");
    assert.deepEqual(parsed[0]!.to, [B]);
    assert.match(parsed[0]!.id, /^file-panel-unify#[0-9]+$/u);
    assert.throws(() => taskName("../escape"), /Invalid/u);
    assert.throws(() => taskName(".mailing"), /Invalid/u);
});

test("memory list is a single shallow directory query, without reading Mailing state", async (t) => {
    const { fs, mailing } = fixture();
    t.after(async () => mailing.close());
    const result = await mailing.list({ instance, workspace });
    assert.deepEqual(result, { memories: [A, B].sort() });
    assert.deepEqual(fs.calls, ["file_glob"]);
    assert.deepEqual(fs.globDepths, [1]);
});

test("Mailing binds direct Memory operations to their Context but keeps background scans independent", async (t) => {
    const { mailing, openedTargets } = fixture();
    t.after(async () => mailing.close());
    await mailing.status({ instance, workspace, ctxId: "ctx-a" });
    await mailing.list({ instance, workspace, ctxId: "ctx-a" });
    await mailing.scan({ instance, workspace });
    assert.deepEqual(openedTargets.map((target) => target.ctxId), ["ctx-a", "ctx-a", undefined]);
});

test("Memory bindings derive Mailing identities and Subject notifications are idempotent", async (t) => {
    const { fs, notices, mailing } = fixture();
    t.after(async () => mailing.close());
    await mailing.inherit({ instance, workspace, ctxId: "ctx-b" }, B);
    await mailing.inherit({ instance, workspace, ctxId: "ctx-a" }, A);
    fs.files.set(outbox, mail("Upload Context owner", "Sensitive full body line"));
    await mailing.scan({ instance, workspace });
    await mailing.scan({ instance, workspace });
    assert.ok(fs.globDepths.includes(2), "Outbox discovery is limited to two levels");
    assert.equal(fs.files.get(inbox)!.match(/<!-- MAIL ID file-panel-unify#1 -->/gu)?.length, 1);
    assert.match(fs.files.get(inbox)!, /Sensitive full body line/u);
    assert.equal(fs.files.get(index)!.match(/<!-- MAIL ID file-panel-unify#1 -->/gu)?.length, 1);
    assert.deepEqual(notices.filter((n) => n.message.includes("New Mail")), [
        { ctxId: "ctx-b", message: "New Mail\nFrom: file-panel-unify\nSubject: Upload Context owner" },
    ]);
    assert.ok(!notices.some((n) => n.message.includes("Sensitive full body")));
    assert.deepEqual(await mailing.status({ instance, workspace, ctxId: "ctx-b" }),
        { name: B, directory: workspace + "/" + root + B,
            mailbox: workspace + "/" + inbox });
});

test("Memory init creates only when explicit, while inherit transfers the same directory and mailbox", async (t) => {
    const { mailing, fs } = fixture();
    t.after(async () => mailing.close());
    const a = { instance, workspace, ctxId: "ctx-a" };
    const b = { instance, workspace, ctxId: "ctx-b" };
    const name = "new-memory";
    assert.deepEqual(await mailing.status(a), {});
    assert.equal(fs.files.has(root + name + "/INDEX.md"), false);
    await assert.rejects(mailing.inherit(a, name), /does not exist/u);
    await assert.rejects(mailing.init(a, B), /already exists/u);
    assert.equal(fs.files.has(root + name + "/INDEX.md"), false);
    assert.deepEqual(await mailing.init(a, name), {
        name, directory: workspace + "/" + root + name,
        mailbox: workspace + "/" + root + name + "/mailbox.md",
    });
    assert.equal(fs.files.get(root + name + "/INDEX.md"), "# new-memory\n");
    assert.deepEqual(await mailing.list(a), { memories: [B, A, name].sort() });
    assert.deepEqual(await mailing.inherit(b, name), await mailing.status(b));
    assert.deepEqual(await mailing.status(a), {});
    assert.equal(fs.files.get(root + name + "/INDEX.md"), "# new-memory\n");
    assert.deepEqual(await mailing.release(b), { released: name });
    assert.deepEqual(await mailing.status(b), {});
    assert.equal(fs.files.has(root + name + "/INDEX.md"), true);
});

test("Auto Memory binds only on the first regular ToolCall and remains stable under concurrency", async (t) => {
    const { mailing, fs } = fixture();
    t.after(async () => mailing.close());
    const target = { instance, workspace, ctxId: "ctx-a" };
    const hook = createMemoryAutoHook(mailing, (error) => assert.fail(String(error)));
    const call = (toolName: string, command = "pwd") => ({
        callId: "first-work", direction: "inbound" as const,
        value: { kind: "call" as const, toolName,
            payload: toolName === "tmux_input" ? { text: command } : { command },
            context: { ...target, source: "mcp" as const } },
    });
    const invocation = {} as never;
    await hook(call("environ_info") as never, invocation);
    assert.deepEqual(await mailing.status(target), {});
    for (const [toolName, command] of [
        ["bash_run", "devshell memory init explicit-name"],
        ["bash_run", "devshell memory init explicit-name; pwd"],
        ["bash_run", "cd /testspace/workspace && devshell memory inherit old-name"],
        ["bash_run", "printf ready; devshell memory init explicit-name\npwd"],
        ["tmux_run", "devshell memory init explicit-name && pwd"],
        ["tmux_input", "devshell memory inherit old-name\n"],
    ]) {
        await hook(call(toolName!, command!) as never, invocation);
        assert.deepEqual(await mailing.status(target), {});
    }
    await Promise.all(Array.from({ length: 8 }, () => hook(call("file_read") as never, invocation)));
    const selected = await mailing.status(target);
    assert.ok("name" in selected);
    assert.match(selected.name, /^auto-[0-9a-f]{12}$/u);
    assert.equal(fs.files.get(root + selected.name + "/INDEX.md"), `# ${selected.name}\n`);
    assert.equal((await mailing.list(target)).memories.filter((name) => name.startsWith("auto-")).length, 1);
    await hook(call("bash_run") as never, invocation);
    assert.deepEqual(await mailing.status(target), selected);
});

test("Explicit Memory init and inherit take priority and invalidate a previous owner's auto cache", async (t) => {
    const { mailing, fs } = fixture();
    t.after(async () => mailing.close());
    const a = { instance, workspace, ctxId: "ctx-a" };
    const b = { instance, workspace, ctxId: "ctx-b" };
    const explicit = await mailing.init(a, "named-work");
    assert.deepEqual(await mailing.ensureBound(a), explicit);
    assert.equal((await mailing.list(a)).memories.filter((name) => name.startsWith("auto-")).length, 0);
    await mailing.inherit(b, "named-work");
    assert.deepEqual(await mailing.status(a), {});
    const fallback = await mailing.ensureBound(a);
    assert.match(fallback.name, /^auto-/u);
    assert.notEqual(fallback.name, explicit.name);
    assert.deepEqual(await mailing.status(b), explicit);
    assert.equal(fs.files.get(root + explicit.name + "/INDEX.md"), "# named-work\n");
});

test("Memory owner cache follows the durable binding even when inherited mail delivery fails", async (t) => {
    const { mailing, fs } = fixture();
    t.after(async () => mailing.close());
    const a = { instance, workspace, ctxId: "ctx-a" };
    const b = { instance, workspace, ctxId: "ctx-b" };
    const original = await mailing.init(a, "named-work");
    assert.deepEqual(await mailing.ensureBound(a), original);
    fs.files.set(outbox, mail("Unsent notice", "Retained in the journal", "named-work"));
    fs.failAppendOnceOn = root + "named-work/mailbox.md";
    await assert.rejects(mailing.inherit(b, "named-work"), /simulated Worker disconnect/u);

    // The binding committed before the Mailing failure; old cache must not
    // grant the transferred directory back to its previous Context.
    assert.deepEqual(await mailing.status(a), {});
    assert.deepEqual(await mailing.status(b), original);
    const newBinding = await mailing.ensureBound(a);
    assert.match(newBinding.name, /^auto-[0-9a-f]{12}$/u);
    assert.notEqual(newBinding.name, original.name);
    assert.deepEqual(await mailing.status(a), newBinding);
    assert.deepEqual(await mailing.status(b), original);
});

test("Memory inherits legacy Mailing claims without losing accepted message state", async (t) => {
    const { mailing, fs } = fixture();
    t.after(async () => mailing.close());
    fs.files.set(root + ".mailing/state.json", JSON.stringify({
        version: 1, claims: { [A]: "ctx-a" }, accepted: { "historic#1": "fingerprint" },
    }));
    assert.equal((await mailing.status({ instance, workspace, ctxId: "ctx-a" }) as { name: string }).name, A);
    await mailing.inherit({ instance, workspace, ctxId: "ctx-b" }, A);
    const stored = JSON.parse(fs.files.get(root + ".mailing/state.json")!) as {
        version: number; bindings: Record<string, string>; accepted: Record<string, string>;
    };
    assert.equal(stored.version, 3);
    assert.deepEqual(stored.bindings, { [A]: "ctx-b" });
    assert.deepEqual(stored.accepted, { "historic#1": "fingerprint" });
});

test("Memory CLI uses the caller Context for model operations and explicit target for native operations", async (t) => {
    const { mailing, fs } = fixture();
    t.after(async () => mailing.close());
    const caller = { ctxId: "ctx-a", instance, workspace } as CliModelCommandInvocationContext;
    assert.deepEqual(await executeMemoryModelCommand(mailing, [], caller), { kind: "json", value: {} });
    const initialized = await executeMemoryModelCommand(mailing, ["init", "cli-owned"], caller);
    assert.equal(initialized.kind, "json");
    assert.equal((initialized as unknown as { value: { name: string } }).value.name, "cli-owned");
    assert.equal(fs.files.get(root + "cli-owned/INDEX.md"), "# cli-owned\n");
    const inherited = await executeMemoryModelCommand(mailing, ["inherit", A], caller);
    assert.equal((inherited as unknown as { value: { name: string } }).value.name, A);
    const native = { localOwner: true } as CliNativeCommandInvocationContext;
    const list = await executeMemoryNativeCommand(mailing, ["list", instance, workspace], native);
    assert.deepEqual((list as unknown as { value: { memories: string[] } }).value.memories, [B, A, "cli-owned"].sort());
    const result = await executeMemoryNativeCommand(mailing, ["inherit", instance, workspace, "ctx-b", A], native);
    assert.equal((result as unknown as { value: { name: string } }).value.name, A);
    assert.deepEqual(await executeMemoryModelCommand(mailing, ["status"], caller), { kind: "json", value: {} });
    assert.equal(fs.files.get(root + "cli-owned/INDEX.md"), "# cli-owned\n");
    await assert.rejects(executeMemoryModelCommand(mailing, ["init"], caller), /Usage/u);
    await assert.rejects(executeMemoryNativeCommand(mailing, ["list", instance, workspace], {
        localOwner: false,
    } as CliNativeCommandInvocationContext), /local Control owner/u);
});

test("A failed Subject notification remains durable after its Mail has been accepted", async (t) => {
    const { fs, mailing, notices, errors, failNoticeOnce } = fixture();
    t.after(async () => mailing.close());
    await mailing.inherit({ instance, workspace, ctxId: "ctx-b" }, B);
    failNoticeOnce();
    fs.files.set(outbox, mail("Retry Subject", "Persistent message body"));
    await mailing.scan({ instance, workspace });
    assert.match(fs.files.get(inbox)!, /Persistent message body/u);
    const stateFile = root + ".mailing/state.json";
    const failed = JSON.parse(fs.files.get(stateFile)!) as {
        accepted: Record<string, string>;
        pendingNotices: Record<string, { recipient: string; text: string }>;
    };
    assert.equal(Object.keys(failed.accepted).length, 1);
    assert.equal(Object.keys(failed.pendingNotices).length, 1);
    assert.equal(notices.length, 0);
    assert.match(String(errors[0]), /simulated Comment queue failure/u);

    await mailing.scan({ instance, workspace });
    await mailing.scan({ instance, workspace });
    assert.deepEqual(notices, [{
        ctxId: "ctx-b",
        message: "New Mail\nFrom: file-panel-unify\nSubject: Retry Subject",
    }]);
    const recovered = JSON.parse(fs.files.get(stateFile)!) as { pendingNotices: Record<string, unknown> };
    assert.deepEqual(recovered.pendingNotices, {});
    assert.equal(fs.files.get(inbox)!.match(/<!-- MAIL ID file-panel-unify#1 -->/gu)?.length, 1);
});

test("Control restart resumes shell-written Outbox scans and durable Subject retries", async (t) => {
    const { fs, mailing, contexts, worker, notices, errors, failNoticeOnce } = fixture();
    t.after(async () => mailing.close());
    await mailing.inherit({ instance, workspace, ctxId: "ctx-b" }, B);
    failNoticeOnce();
    fs.files.set(outbox, mail("Restart delivery", "Sent before Control restart"));
    await mailing.scan({ instance, workspace });
    assert.equal(notices.length, 0);
    await mailing.close();

    const recovered = new MailingService({
        worker, contexts,
        comment: { async queue(_instance, ctxId, message) { notices.push({ ctxId, message }); } },
        onError(error) { errors.push(error); },
        pollMs: 3_600_000,
    });
    t.after(async () => recovered.close());
    // No memory status/init/inherit, and the new service has no cached scopes.
    await recovered.poll();
    assert.deepEqual(notices, [{
        ctxId: "ctx-b",
        message: "New Mail\nFrom: file-panel-unify\nSubject: Restart delivery",
    }]);
    fs.files.set(outbox, fs.files.get(outbox)! + mail("Shell-only edit", "Written via shell"));
    await recovered.poll();
    assert.match(fs.files.get(inbox)!, /Written via shell/u);
    assert.equal(notices.filter((entry) => entry.message.includes("Shell-only edit")).length, 1);
    await recovered.poll();
    assert.equal(notices.length, 2);
    assert.equal(errors.length, 1);
});

test("Pending Subjects follow a Memory inheritance after the original Context retires", async (t) => {
    const { fs, mailing, notices, active } = fixture();
    t.after(async () => mailing.close());
    fs.files.set(outbox, mail("Offline delivery", "Mailbox persists"));
    await mailing.scan({ instance, workspace });
    assert.equal(notices.length, 0);
    active.delete("ctx-a");
    await mailing.inherit({ instance, workspace, ctxId: "ctx-b" }, B);
    assert.ok(notices.some((entry) => entry.ctxId === "ctx-b" &&
        entry.message.includes("Subject: Offline delivery")));
});

test("Mailing repairs a partial delivery after a Worker failure without duplicate messages", async (t) => {
    const { fs, mailing } = fixture();
    t.after(async () => mailing.close());
    fs.files.set(outbox, mail("Retry delivery", "*** End Edit\nBody survives"));
    fs.failAppendOnceOn = inbox;
    await assert.rejects(mailing.scan({ instance, workspace }), /simulated Worker disconnect/u);
    assert.match(fs.files.get(index)!, /Retry delivery/u);
    await mailing.scan({ instance, workspace });
    await mailing.scan({ instance, workspace });
    assert.equal(fs.files.get(index)!.match(/Retry delivery/gu)?.length, 1);
    assert.equal(fs.files.get(inbox)!.match(/Retry delivery/gu)?.length, 1);
    assert.match(fs.files.get(inbox)!, /\*\*\* End Edit/u);
});

test("Mailing returns a bounce for unknown recipients and waits for complete mail", async (t) => {
    const { fs, mailing } = fixture();
    t.after(async () => mailing.close());
    const full = mail("Pending", "body", "missing-recipient");
    fs.files.set(outbox, full.replace("<!-- MAIL END -->", ""));
    await mailing.scan({ instance, workspace });
    assert.equal(fs.files.has(root + A + "/mailbox.md"), false);
    fs.files.set(outbox, full);
    await mailing.scan({ instance, workspace });
    assert.match(fs.files.get(root + A + "/mailbox.md")!, /Unknown Agent Work recipient: missing-recipient/u);
});

test("Mailing detects modification of a previously published Outbox entry", async (t) => {
    const { fs, mailing } = fixture();
    t.after(async () => mailing.close());
    fs.files.set(outbox, mail("Immutable", "original"));
    await mailing.scan({ instance, workspace });
    fs.files.set(outbox, mail("Immutable", "tampered"));
    await assert.rejects(mailing.scan({ instance, workspace }), /changed after publication/u);
});

test("Mailing Hook ignores extension-owned writes and triggers after committed edits", async () => {
    const triggered: string[] = [];
    const hook = createMailingHook({
        async scan(input) { triggered.push(input.workspace); },
    }, () => undefined);
    const value = {
        callId: "call-1",
        direction: "outbound" as const,
        value: {
            context: { instance, workspace, source: "mcp" as const },
            kind: "result" as const,
            payload: { operations: [{ path: "./" + outbox, status: "applied" }] },
            toolName: "file_edit",
        },
    };
    const invocation = {
        signal: new AbortController().signal,
        requestInterface: async () => undefined,
    };
    await hook(value, invocation);
    assert.deepEqual(triggered, [workspace]);
    await hook({ ...value, value: { ...value.value, context: { instance, workspace, source: "extension" } } }, invocation);
    assert.deepEqual(triggered, [workspace]);
});

test("An invalid sender cannot block delivery of another Agent Work's mail", async (t) => {
    const { fs, mailing, errors } = fixture();
    t.after(async () => mailing.close());
    fs.files.set(outbox, "<!-- MAIL BEGIN -->\nTo: invalid/recipient\nSubject: bad\n\nbad\n<!-- MAIL END -->\n");
    fs.files.set(root + B + "/chat.md", mail("Valid sender", "Independent body", A));
    await mailing.scan({ instance, workspace });
    assert.equal(errors.length, 1);
    assert.match(fs.files.get(root + A + "/mailbox.md")!, /Independent body/u);
});

test("A bounced message notifies the sender's claimed Context by Subject", async (t) => {
    const { fs, mailing, notices } = fixture();
    t.after(async () => mailing.close());
    await mailing.inherit({ instance, workspace, ctxId: "ctx-a" }, A);
    fs.files.set(outbox, mail("Undeliverable test", "Not part of notification", "missing-agent"));
    await mailing.scan({ instance, workspace });
    assert.ok(notices.some((n) => n.ctxId === "ctx-a" &&
        n.message === "New Mail\nFrom: mailer-daemon\nSubject: Undeliverable: Undeliverable test"));
    assert.ok(!notices.some((n) => n.message.includes("Not part of notification")));
});

test("Concurrent Mailing scans deliver one mailbox entry, index entry and Subject", async (t) => {
    const { fs, mailing, notices } = fixture();
    t.after(() => mailing.close());
    await mailing.inherit({ instance, workspace, ctxId: "ctx-b" }, B);
    fs.files.set(outbox, mail("Concurrent delivery", "Only one copy"));
    await Promise.all(Array.from({ length: 3 }, () => mailing.scan({ instance, workspace })));
    assert.equal(fs.files.get(inbox)!.match(/<!-- MAIL ID file-panel-unify#1 -->/gu)?.length, 1);
    assert.equal(fs.files.get(index)!.match(/<!-- MAIL ID file-panel-unify#1 -->/gu)?.length, 1);
    assert.deepEqual(notices, [{ ctxId: "ctx-b",
        message: "New Mail\nFrom: file-panel-unify\nSubject: Concurrent delivery" }]);
    const state = JSON.parse(fs.files.get(root + ".mailing/state.json")!);
    assert.deepEqual(Object.keys(state.accepted), [A + "#1"]);
    assert.deepEqual(state.pendingNotices, {});
});

test("Competing Memory inheritances leave one durable owner and preserve the mailbox", async (t) => {
    const { fs, mailing, worker, contexts, notices } = fixture();
    t.after(() => mailing.close());
    fs.files.set(inbox, "# Mailbox\nExisting durable memory\n");
    fs.files.set(root + B + "/notes.md", "Keep these decisions\n");
    await Promise.all([
        mailing.inherit({ instance, workspace, ctxId: "ctx-b" }, B),
        mailing.inherit({ instance, workspace, ctxId: "ctx-c" }, B),
    ]);
    const statuses = await Promise.all(["ctx-b", "ctx-c"].map((ctxId) =>
        mailing.status({ instance, workspace, ctxId })));
    assert.equal(statuses.filter((status) => status.name === B).length, 1);
    const state = JSON.parse(fs.files.get(root + ".mailing/state.json")!);
    const owner = state.bindings[B] as string;
    assert.ok(["ctx-b", "ctx-c"].includes(owner));
    assert.equal(fs.files.get(inbox), "# Mailbox\nExisting durable memory\n");
    assert.equal(fs.files.get(root + B + "/notes.md"), "Keep these decisions\n");
    await mailing.close();

    const recovered = new MailingService({ worker, contexts, pollMs: 3_600_000,
        comment: { async queue(_instance, ctxId, message) { notices.push({ ctxId, message }); } },
        onError: (error) => assert.fail(String(error)),
    });
    t.after(() => recovered.close());
    assert.equal((await recovered.status({ instance, workspace, ctxId: owner })).name, B);
    notices.length = 0;
    fs.files.set(outbox, mail("After inheritance", "Append to existing mailbox"));
    await recovered.poll();
    assert.deepEqual(notices, [{ ctxId: owner,
        message: "New Mail\nFrom: file-panel-unify\nSubject: After inheritance" }]);
    assert.match(fs.files.get(inbox)!, /Existing durable memory/u);
    assert.match(fs.files.get(inbox)!, /Append to existing mailbox/u);
});

test("Mailing replays mailbox writes after a failed acceptance save and Control restart", async (t) => {
    const { fs, mailing, worker, contexts, notices } = fixture();
    t.after(() => mailing.close());
    await mailing.inherit({ instance, workspace, ctxId: "ctx-b" }, B);
    fs.files.set(outbox, mail("Save interrupted", "Mailbox committed before state"));
    const stateFile = root + ".mailing/state.json";
    fs.beforeEdit = (path) => {
        if (path === stateFile && fs.files.get(inbox)?.includes("Mailbox committed before state")) {
            fs.beforeEdit = undefined;
            throw new Error("simulated Worker disconnect");
        }
    };
    await assert.rejects(mailing.scan({ instance, workspace }), /simulated Worker disconnect/u);
    assert.match(fs.files.get(inbox)!, /Mailbox committed before state/u);
    assert.deepEqual(JSON.parse(fs.files.get(stateFile)!).accepted, {});
    assert.equal(notices.length, 0);
    await mailing.close();

    const recovered = new MailingService({ worker, contexts, pollMs: 3_600_000,
        comment: { async queue(_instance, ctxId, message) { notices.push({ ctxId, message }); } },
        onError: (error) => assert.fail(String(error)),
    });
    t.after(() => recovered.close());
    await recovered.poll();
    await recovered.poll();
    assert.equal(fs.files.get(inbox)!.match(/<!-- MAIL ID file-panel-unify#1 -->/gu)?.length, 1);
    assert.equal(fs.files.get(index)!.match(/<!-- MAIL ID file-panel-unify#1 -->/gu)?.length, 1);
    assert.deepEqual(notices, [{ ctxId: "ctx-b",
        message: "New Mail\nFrom: file-panel-unify\nSubject: Save interrupted" }]);
    assert.deepEqual(Object.keys(JSON.parse(fs.files.get(stateFile)!).accepted), [A + "#1"]);
});

test("Memory rejects an inactive or out-of-scope Context without stealing the binding", async (t) => {
    const { mailing, fs, active, worker, contexts } = fixture();
    t.after(() => mailing.close());
    await mailing.inherit({ instance, workspace, ctxId: "ctx-b" }, B);
    const state = fs.files.get(root + ".mailing/state.json");
    active.delete("ctx-c");
    await assert.rejects(mailing.inherit({ instance, workspace, ctxId: "ctx-c" }, B),
        /active Context in this Instance and Workspace/u);
    const outOfScope = new MailingService({ worker, pollMs: 3_600_000,
        contexts: { ...contexts, async list() {
            return (await contexts.list()).map((context) => ({ ...context,
                environments: [{ instance, workspace: "/other-workspace" }],
            }));
        } },
        comment: { async queue() { assert.fail("Rejected binding must not notify"); } },
        onError: (error) => assert.fail(String(error)),
    });
    t.after(() => outOfScope.close());
    await assert.rejects(outOfScope.inherit({ instance, workspace, ctxId: "ctx-a" }, B),
        /active Context in this Instance and Workspace/u);
    assert.equal(fs.files.get(root + ".mailing/state.json"), state);
    assert.equal((await mailing.status({ instance, workspace, ctxId: "ctx-b" })).name, B);
    assert.deepEqual(await mailing.status({ instance, workspace, ctxId: "ctx-a" }), {});
});
