import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
    ExtensionInstanceEvent,
    ExtensionInstanceEventWatch,
    ExtensionInstanceObserveCapability,
} from "@portable-devshell/extension/instance";
import type { ExtensionContextObserveCapability } from "@portable-devshell/extension/context";
import { TerminalHandoffWatcher } from "../../src/handoff/Watcher.ts";
import { CommentService } from "../../src/comment/CommentService.ts";
import { MessageStore } from "../../src/message/store/MessageStore.ts";
import { databaseConnection } from "../helpers/Database.ts";

test("TerminalHandoffWatcher queues handoff comments only for active contexts matching instance and workspace", async () => {
    const watches = new Map<string, ExtensionInstanceEventWatch>();
    let aborted = false;
    const instanceObserve: ExtensionInstanceObserveCapability = {
        list: async () => [],
        readLogs: async () => [],
        refresh: async (name) => ({
            connectionState: "connected",
            daemonState: "running",
            lastSeq: 10,
            name,
            ready: true,
            status: "ready",
        }),
        snapshot: async (name) => ({
            connectionState: "connected",
            daemonState: "running",
            lastSeq: 10,
            name,
            ready: true,
            status: "ready",
        }),
        watchEvents: async (name, watch) => {
            watches.set(name, watch);
            await new Promise<void>((resolve) => {
                watch.signal.addEventListener(
                    "abort",
                    () => {
                        aborted = true;
                        resolve();
                    },
                    { once: true },
                );
            });
        },
    };
    const contextObserve: ExtensionContextObserveCapability = {
        list: async () => [
            {
                createdAt: "2026-11-26T00:00:00.000Z",
                ctxId: "ctx-match",
                environments: [{ instance: "alpha", workspace: "/ws/a" }],
                expiresAt: "2026-11-27T00:00:00.000Z",
                lastAccessedAt: "2026-11-26T00:00:00.000Z",
                status: "active",
            },
            {
                createdAt: "2026-11-26T00:00:00.000Z",
                ctxId: "ctx-recent",
                environments: [{ instance: "alpha", workspace: "/ws/a" }],
                expiresAt: "2026-11-27T00:00:00.000Z",
                lastAccessedAt: "2026-11-26T00:02:00.000Z",
                status: "active",
            },
            {
                createdAt: "2026-11-26T00:00:00.000Z",
                ctxId: "ctx-other-ws",
                environments: [{ instance: "alpha", workspace: "/ws/b" }],
                expiresAt: "2026-11-27T00:00:00.000Z",
                lastAccessedAt: "2026-11-26T00:00:00.000Z",
                status: "active",
            },
            {
                createdAt: "2026-11-26T00:00:00.000Z",
                ctxId: "ctx-stateless",
                environments: [{ instance: "alpha" }],
                expiresAt: "2026-11-27T00:00:00.000Z",
                lastAccessedAt: "2026-11-26T00:00:00.000Z",
                status: "active",
            },
        ],
    };
    const queued: Array<{ ctxId: string; instance: string; text: string }> = [];
    const watcher = new TerminalHandoffWatcher({
        contextObserve,
        instanceObserve,
        ...memoryCursor(),
        queue: async (instance, _id, text, selectRecipient) => {
            const ctxId = await selectRecipient();
            assert.ok(ctxId);
            queued.push({ ctxId, instance, text });
        },
        reconnectDelayMs: 50,
    });

    watcher.sync([{ enabled: true, name: "alpha" }]);
    const deadline = Date.now() + 2_000;
    while (!watches.has("alpha") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const watch = watches.get("alpha");
    assert.ok(watch);
    assert.equal(watch.fromSeq, 11);
    assert.deepEqual(watch.eventTypes, ["terminal.controlReleased"]);

    const event: ExtensionInstanceEvent = {
        at: "2026-11-26T00:01:00.000Z",
        data: {
            cols: 120,
            cwd: "./app",
            generation: 1,
            name: "dev-server",
            rows: 36,
            terminalId: "process-1111",
            workspace: "/ws/a",
        },
        instanceName: "alpha",
        seq: 11,
        type: "terminal.controlReleased",
    };
    await Promise.all([watch.onEvent(event), watch.onEvent(event)]);

    assert.deepEqual(
        queued.map((item) => item.ctxId),
        ["ctx-recent"],
    );
    assert.match(
        queued[0]!.text,
        /\[Terminal handoff\].*"dev-server" \(process-1111\).*120x36.*belongs to your current task.*task_inspect before resuming.*omit any pre-handoff cursor/u,
    );

    // Stateless release (workspace: undefined) notifies only stateless contexts.
    await watch.onEvent({
        at: "2026-11-26T00:02:00.000Z",
        data: {
            cols: 80,
            generation: 2,
            rows: 24,
            terminalId: "process-stateless",
        },
        instanceName: "alpha",
        seq: 12,
        type: "terminal.controlReleased",
    });
    assert.deepEqual(
        queued.map((item) => item.ctxId),
        ["ctx-recent", "ctx-stateless"],
    );

    await watcher.close();
    assert.equal(aborted, true);
});

function memoryCursor() {
    let seq: number | undefined;
    return {
        readCursor: async () => seq,
        writeCursor: async (_instance: string, value: number) => { seq = value; },
    };
}

function release(seq: number, at = "2026-11-26T00:01:00.000Z"): ExtensionInstanceEvent {
    return {
        at, data: { terminalId: `process-${seq}`, generation: 1, releasedAt: at, workspace: "/repo/" },
        instanceName: "alpha", seq, type: "terminal.controlReleased",
    };
}

function activeContext(ctxId: string) {
    return {
        createdAt: "2026-11-26T00:00:00.000Z",
        ctxId, environments: [{ instance: "alpha", workspace: "/repo" }],
        expiresAt: "2026-11-27T00:00:00.000Z", lastAccessedAt: "2026-11-26T00:00:00.000Z",
        status: "active" as const,
    };
}

function deferred() {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

function watchSource(lastSeq = 10) {
    const watches: ExtensionInstanceEventWatch[] = [];
    const finishes: Array<ReturnType<typeof deferred>> = [];
    const snapshot = async (name: string) => ({
        connectionState: "connected" as const, daemonState: "running" as const,
        lastSeq, name, ready: true, status: "ready" as const,
    });
    let snapshots = 0;
    const instanceObserve: ExtensionInstanceObserveCapability = {
        list: async () => [], readLogs: async () => [], refresh: snapshot,
        snapshot: async (name) => { snapshots += 1; return await snapshot(name); },
        watchEvents: async (_name, watch) => {
            const finished = deferred();
            watches.push(watch);
            finishes.push(finished);
            const abort = () => finished.resolve();
            watch.signal.addEventListener("abort", abort, { once: true });
            try { await finished.promise; }
            finally { watch.signal.removeEventListener("abort", abort); }
        },
    };
    return {
        instanceObserve, finishes,
        snapshotCount: () => snapshots,
        async watch(index: number) {
            const deadline = Date.now() + 2_000;
            while (watches.length <= index && Date.now() < deadline) await delay(5);
            assert.ok(watches[index], `missing watch ${index}`);
            return watches[index];
        },
    };
}

const instances = [{ enabled: true, name: "alpha" }];

function streamGap(fromSeq: number, nextSeq: number, lastSeq: number) {
    return Object.assign(new Error("stream.gap"), {
        code: "stream.gap",
        details: { requestedFromSeq: fromSeq, oldestAvailableSeq: nextSeq, latestSeq: lastSeq },
    });
}

for (const path of ["live", "reconnect"] as const) {
    test(`handoff resumes from the oldest retained event after a ${path} gap`, async (t) => {
        const source = watchSource();
        const cursor = memoryCursor();
        const queued: string[] = [];
        const watcher = new TerminalHandoffWatcher({
            ...cursor, ...source, reconnectDelayMs: 0,
            contextObserve: { list: async () => [activeContext("repo")] },
            queue: async (_instance, _id, text) => { queued.push(text); },
        });
        t.after(() => watcher.close());
        watcher.sync(instances);
        const first = await source.watch(0);
        assert.equal(first.fromSeq, 11);
        if (path === "live") await first.onGap!({ nextSeq: 14, lastSeq: 15 });
        else source.finishes[0]!.reject(streamGap(11, 14, 15));
        const resumed = path === "live" ? first : await source.watch(1);
        if (path === "reconnect") assert.equal(resumed.fromSeq, 14);
        assert.equal(await cursor.readCursor(), 13);
        await resumed.onEvent(release(14));
        await resumed.onEvent(release(15));
        assert.deepEqual(queued.map((text) => text.match(/process-\d+/u)?.[0]), ["process-14", "process-15"]);
        assert.equal(await cursor.readCursor(), 15);
        assert.equal(source.snapshotCount(), 1);
    });
}

test("a failed Context lookup fences already scheduled handoffs and gaps until replay", async (t) => {
    const source = watchSource();
    const cursor = memoryCursor();
    const queued: string[] = [];
    let listCalls = 0;
    const watcher = new TerminalHandoffWatcher({
        ...cursor, ...source, reconnectDelayMs: 0,
        contextObserve: { list: async () => {
            if (++listCalls === 1) throw new TypeError("lookup failed while processing seq");
            return [activeContext("repo")];
        } },
        queue: async (_instance, _id, text, selectRecipient) => {
            assert.equal(await selectRecipient(), "repo");
            queued.push(text);
        },
    });
    t.after(() => watcher.close());
    watcher.sync(instances);
    const first = await source.watch(0);
    const failed = assert.rejects(async () => await first.onEvent(release(11)), /lookup failed/u);
    const later = first.onEvent(release(12));
    const gap = first.onGap!({ nextSeq: 14, lastSeq: 15 });
    await Promise.all([failed, later, gap]);
    assert.equal(queued.length, 0);
    assert.equal(await cursor.readCursor(), 10);
    const retry = await source.watch(1);
    assert.equal(retry.fromSeq, 11);
    await retry.onEvent(release(11));
    await retry.onEvent(release(12));
    assert.deepEqual(queued.map((text) => text.match(/process-\d+/u)?.[0]), ["process-11", "process-12"]);
    assert.equal(await cursor.readCursor(), 12);
    assert.equal(source.snapshotCount(), 1);
});

test("a lost Comment commit reply replays from the durable checkpoint to the original recipient after restart", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "devshell-handoff-"));
    const filePath = join(dir, "messages.sqlite3");
    let recipient = "before-restart";
    let loseCommit = false;
    let failReset = false;
    const published: unknown[] = [];
    const stores: MessageStore[] = [];
    const watchers: TerminalHandoffWatcher[] = [];
    t.after(async () => {
        for (const watcher of watchers) await watcher.close();
        for (const store of stores) await store.close();
        await rm(dir, { recursive: true, force: true });
    });
    function open(source: ReturnType<typeof watchSource>, reconnectDelayMs = 5_000) {
        const store = new MessageStore({
            instanceName: "alpha", filePath,
            openDatabase: async () => {
                const db = await databaseConnection(filePath);
                return { ...db, async transaction(work) {
                    const result = await db.transaction(work);
                    if (loseCommit) {
                        loseCommit = false;
                        throw new Error("lost SQLite commit response");
                    }
                    return result;
                } };
            },
        });
        const comments = new CommentService({ instanceName: "alpha", store,
            appendEvent: async (_type, data) => { published.push(data); },
        });
        const watcher = new TerminalHandoffWatcher({
            ...source, reconnectDelayMs,
            contextObserve: { list: async () => [activeContext(recipient)] },
            readCursor: () => store.readHandoffCursor(),
            writeCursor: async (_instance, seq) => {
                if (seq === 0 && failReset) {
                    failReset = false;
                    throw new Error("reset checkpoint write failed");
                }
                await store.writeHandoffCursor(seq);
            },
            queue: (_instance, id, text, choose) => comments.queueHandoff(id, text, choose),
        });
        stores.push(store);
        watchers.push(watcher);
        watcher.sync(instances);
        return { watcher, comments, store };
    }

    const source = watchSource();
    const first = open(source);
    const original = await source.watch(0);
    const event = release(11);
    loseCommit = true;
    await assert.rejects(async () => await original.onEvent(event), /lost SQLite commit response/u);
    assert.equal(await first.store.readHandoffCursor(), 10);
    const admitted = await first.comments.list();
    assert.equal(admitted.length, 1);
    assert.equal(admitted[0]!.ctxId, "before-restart");
    assert.deepEqual(published, []);
    await first.watcher.close();
    await first.store.close();

    recipient = "after-restart";
    const newSource = watchSource(20);
    const restarted = open(newSource);
    const replay = await newSource.watch(0);
    assert.equal(replay.fromSeq, 11);
    await replay.onEvent(event);
    assert.equal(newSource.snapshotCount(), 0);
    assert.equal(await restarted.store.readHandoffCursor(), 11);
    assert.deepEqual((await restarted.comments.list()).map(({ id, ctxId }) => ({ id, ctxId })),
        [{ id: admitted[0]!.id, ctxId: "before-restart" }]);
    assert.equal(published.length, 1);

    // A replacement source explicitly rejects the old high cursor. A new
    // event using the old sequence must not match the earlier receipt.
    await restarted.watcher.close();
    const resetSource = watchSource(5);
    const reset = open(resetSource, 0);
    const ahead = await resetSource.watch(0);
    assert.equal(ahead.fromSeq, 12);
    failReset = true;
    resetSource.finishes[0]!.reject(streamGap(12, 1, 5));
    const fromStart = await resetSource.watch(1);
    assert.equal(fromStart.fromSeq, 1);
    assert.equal(await reset.store.readHandoffCursor(), 0);
    await fromStart.onEvent(release(11, "2026-11-26T00:05:00.000Z"));
    assert.deepEqual((await reset.comments.list()).map((item) => item.ctxId).sort(), ["after-restart", "before-restart"]);
});
