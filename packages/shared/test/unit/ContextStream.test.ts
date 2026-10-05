import assert from "node:assert/strict";
import test from "node:test";

import { ContextViewModel } from "../../src/workspace/context/ViewModel.ts";
import type { ContextChangeEvent, ContextSnapshot } from "../../src/workspace/context/Revision.ts";
import { createContextTransport, type ContextTransport } from "../../src/workspace/context/Transport.ts";
import type { EventStreamPort, StreamMessage } from "../../src/client/Stream.ts";
import type { ContextRecord } from "../../src/workspace/context/Model.ts";
import { CONTROL_HOST } from "../../src/client/Control.ts";
import { Endpoint } from "../../src/transport/endpoint/Endpoint.ts";
import type { Channel } from "../../src/transport/endpoint/channel/Channel.ts";
import { Rpc } from "../../src/transport/packet/Rpc.ts";
import { Stream } from "../../src/transport/packet/Stream.ts";

function deferred<Value>() {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>((complete) => { resolve = complete; });
    return { promise, resolve };
}

class Feed implements EventStreamPort<ContextChangeEvent> {
    readonly messages: StreamMessage<ContextChangeEvent>[] = [];
    readonly waiters: Array<(message: StreamMessage<ContextChangeEvent>) => void> = [];
    closed = false;

    push(message: StreamMessage<ContextChangeEvent>): void {
        const waiter = this.waiters.shift();
        if (waiter !== undefined) waiter(message);
        else this.messages.push(message);
    }

    next(): Promise<StreamMessage<ContextChangeEvent>> {
        const message = this.messages.shift();
        return message === undefined
            ? new Promise((resolve) => this.waiters.push(resolve))
            : Promise.resolve(message);
    }

    close(): void {
        this.closed = true;
        this.push({ kind: "closed" });
    }
}

function record(ctxId: string, lastAccessedAt: string): ContextRecord {
    return {
        createdAt: "2026-01-01T00:00:00.000Z",
        ctxId,
        environments: [],
        expiresAt: "2027-01-01T00:00:00.000Z",
        lastAccessedAt,
        principal: "user",
        status: "active",
    };
}

function snapshot(revision: number, contexts: ContextRecord[] = []): ContextSnapshot {
    return { contexts, revision };
}

function transport(
    read: () => Promise<ContextSnapshot>,
    open: ContextTransport["subscribe"],
): ContextTransport {
    const unavailable = async (): Promise<never> => { throw new Error("Unexpected context mutation."); };
    return {
        snapshot: read,
        subscribe: open,
        disable: unavailable,
        list: async () => [],
        renew: unavailable,
    };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

class MemoryChannel implements Channel {
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #dataListeners = new Set<(data: Uint8Array) => void>();
    #closed = false;
    #peer?: MemoryChannel;

    get closed(): boolean {
        return this.#closed;
    }

    connect(peer: MemoryChannel): void {
        this.#peer = peer;
    }

    async write(data: Uint8Array): Promise<void> {
        const peer = this.#peer;
        assert.equal(this.#closed, false);
        assert.ok(peer !== undefined && !peer.#closed);
        const copy = Uint8Array.from(data);
        queueMicrotask(() => {
            for (const listener of peer.#dataListeners) listener(copy);
        });
    }

    onData(listener: (data: Uint8Array) => void): () => void {
        this.#dataListeners.add(listener);
        return () => this.#dataListeners.delete(listener);
    }

    onClose(listener: (error?: Error) => void): () => void {
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    close(error?: Error): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const listener of this.#closeListeners) listener(error);
        const peer = this.#peer;
        if (peer !== undefined) queueMicrotask(() => peer.#remoteClose(error));
    }

    #remoteClose(error?: Error): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const listener of this.#closeListeners) listener(error);
    }
}

async function controlEndpoints(): Promise<{ client: Endpoint; server: Endpoint }> {
    const left = new MemoryChannel();
    const right = new MemoryChannel();
    left.connect(right);
    right.connect(left);
    let connected = false;
    const client = new Endpoint({
        host: "client",
        connectChannel: async () => {
            assert.equal(connected, false);
            connected = true;
            return left;
        },
    });
    const server = new Endpoint({ host: CONTROL_HOST });
    const accepting = server.accept(right);
    await client.connect(CONTROL_HOST, "context");
    await accepting;
    return { client, server };
}

test("context transport decodes snapshots, seeded events, and stream gaps", async (t) => {
    const { client, server } = await controlEndpoints();
    t.after(() => {
        client.close();
        server.close();
    });
    const serverRpc = new Rpc(server.bind("context"), {
        snapshot: () => ({ contexts: [record("ctx-wire", "2026-01-01T00:00:00.000Z")], revision: 5 }),
        list: () => [record("ctx-wire", "2026-01-01T00:00:00.000Z")],
        disable: () => record("ctx-wire", "2026-01-02T00:00:00.000Z"),
        renew: () => record("ctx-wire", "2026-01-03T00:00:00.000Z"),
    });
    const serverStreams = new Stream(server.bind("context"));
    let requestedRevision = 0;
    serverStreams.onOpen(async (stream, name, payload) => {
        assert.equal(name, "subscribe");
        requestedRevision = (payload as { fromRevision: number }).fromRevision;
        await stream.send({ name: "seed", payload: { events: [{ ctxIds: ["ctx-wire"], revision: 6 }] } });
        await stream.send({ name: "event", payload: { ctxIds: ["ctx-wire"], revision: 7 } });
        await stream.send({ name: "gap", payload: {
            requestedFromSeq: 8,
            latestSeq: 12,
            oldestAvailableSeq: 10,
        } });
    });
    t.after(() => {
        serverRpc.close();
        serverStreams.close();
    });

    const contextTransport = createContextTransport(client);
    assert.deepEqual(await contextTransport.snapshot(), {
        contexts: [record("ctx-wire", "2026-01-01T00:00:00.000Z")],
        revision: 5,
    });
    assert.deepEqual(await contextTransport.list(), [record("ctx-wire", "2026-01-01T00:00:00.000Z")]);
    assert.deepEqual(await contextTransport.disable("ctx-wire"), record("ctx-wire", "2026-01-02T00:00:00.000Z"));
    assert.deepEqual(await contextTransport.renew("ctx-wire"), record("ctx-wire", "2026-01-03T00:00:00.000Z"));
    const subscription = await contextTransport.subscribe(6);
    assert.deepEqual(await subscription.next(), {
        kind: "event",
        event: { ctxIds: ["ctx-wire"], revision: 6 },
    });
    assert.deepEqual(await subscription.next(), {
        kind: "event",
        event: { ctxIds: ["ctx-wire"], revision: 7 },
    });
    assert.deepEqual(await subscription.next(), {
        kind: "gap",
        details: { requestedFromSeq: 8, latestSeq: 12, oldestAvailableSeq: 10 },
        gap: { fromSeq: 8, lastSeq: 12, nextSeq: 10 },
    });
    assert.equal(requestedRevision, 6);
    subscription.close();
});

test("load snapshots before subscribing, events refresh records, and close closes stream", async () => {
    const first = record("ctx-1", "2026-01-01T00:00:00.000Z");
    const updated = record("ctx-1", "2026-01-02T00:00:00.000Z");
    const feed = new Feed();
    const opened: number[] = [];
    let current = snapshot(4, [first]);
    const model = new ContextViewModel(transport(async () => current, async (revision) => {
        opened.push(revision);
        return feed;
    }));

    await model.load();
    await tick();
    assert.equal(model.state.revision, 4);
    assert.deepEqual(opened, [5]);

    current = snapshot(5, [updated]);
    feed.push({ kind: "event", event: { ctxIds: ["ctx-1"], revision: 5 } });
    await tick();
    assert.equal(model.state.revision, 5);
    assert.equal(model.state.contexts[0]?.lastAccessedAt, updated.lastAccessedAt);

    model.close();
    assert.equal(feed.closed, true);
});

test("close during the initial snapshot prevents load from subscribing", async () => {
    const initial = deferred<ContextSnapshot>();
    const opened: number[] = [];
    const model = new ContextViewModel(transport(() => initial.promise, async (revision) => {
        opened.push(revision);
        return new Feed();
    }));

    const loading = model.load();
    assert.deepEqual(opened, []);
    model.close();
    initial.resolve(snapshot(4, [record("ctx-1", "2026-01-01T00:00:00.000Z")]));
    await loading;

    assert.deepEqual(opened, []);
});

test("gap restores from snapshot and subscribes at the next revision", async () => {
    const firstFeed = new Feed();
    const resumedFeed = new Feed();
    const opened: number[] = [];
    let current = snapshot(2, [record("old", "2026-01-01T00:00:00.000Z")]);
    const model = new ContextViewModel(transport(async () => current, async (revision) => {
        opened.push(revision);
        return opened.length === 1 ? firstFeed : resumedFeed;
    }));

    await model.load();
    await tick();
    current = snapshot(10, [record("new", "2026-01-10T00:00:00.000Z")]);
    firstFeed.push({ kind: "gap", gap: { fromSeq: 3, lastSeq: 10, nextSeq: 8 } });
    await tick();
    await tick();

    assert.deepEqual(opened, [3, 11]);
    assert.equal(firstFeed.closed, true);
    assert.equal(model.state.revision, 10);
    assert.deepEqual(model.state.contexts.map((context) => context.ctxId), ["new"]);
    model.close();
    assert.equal(resumedFeed.closed, true);
});

test("older in-flight snapshot cannot overwrite a newer snapshot", async () => {
    const older = deferred<ContextSnapshot>();
    let reads = 0;
    const model = new ContextViewModel(transport(() => {
        reads += 1;
        return reads === 1 ? older.promise : Promise.resolve(snapshot(8, [record("new", "now")]));
    }, async () => new Feed()));

    const staleRefresh = model.refresh();
    await model.refresh();
    older.resolve(snapshot(3, [record("old", "then")]));
    await staleRefresh;

    assert.equal(model.state.revision, 8);
    assert.deepEqual(model.state.contexts.map((context) => context.ctxId), ["new"]);
    model.close();
});
