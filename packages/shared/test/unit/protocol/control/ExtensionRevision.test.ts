import assert from "node:assert/strict";
import test from "node:test";

import { ExtensionViewModel } from "../../../../src/control/extension/ViewModel.ts";
import type { ExtensionChangeEvent, ExtensionSnapshot, TuiPageSnapshot, WebPageSnapshot } from "../../../../src/control/extension/Model.ts";
import type { ExtensionRuntimeTransport, TuiPageTransport, WebPageTransport } from "../../../../src/control/extension/Transport.ts";
import type { EventStreamPort, StreamMessage } from "../../../../src/client/Stream.ts";
import { createExtensionRuntimeTransport } from "../../../../src/control/extension/Transport.ts";
import { Endpoint } from "../../../../src/transport/endpoint/Endpoint.ts";
import { Rpc } from "../../../../src/transport/packet/Rpc.ts";
import { Stream } from "../../../../src/transport/packet/Stream.ts";

function deferred<Value>() {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>((complete) => { resolve = complete; });
    return { promise, resolve };
}

class Feed implements EventStreamPort<ExtensionChangeEvent> {
    readonly messages: StreamMessage<ExtensionChangeEvent>[] = [];
    readonly waiters: Array<(message: StreamMessage<ExtensionChangeEvent>) => void> = [];
    closed = false;

    push(message: StreamMessage<ExtensionChangeEvent>): void {
        const waiter = this.waiters.shift();
        if (waiter !== undefined) waiter(message);
        else this.messages.push(message);
    }

    next(): Promise<StreamMessage<ExtensionChangeEvent>> {
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

function snapshot(revision: number, ids: string[] = []): ExtensionSnapshot {
    return {
        extensions: ids.map((id) => ({ id, enabled: true, state: "installed" })),
        revision,
        tuiPages: ids.map((id) => ({ id, extensionId: id, title: id })),
        tuiSupported: true,
        webApplications: [],
        webPages: [],
        webSupported: false,
    };
}

function runtime(
    read: () => Promise<ExtensionSnapshot>,
    open: ExtensionRuntimeTransport["subscribe"],
): ExtensionRuntimeTransport {
    const unavailable = async (): Promise<never> => { throw new Error("Unexpected legacy API call."); };
    return {
        snapshot: read, subscribe: open,
        disable: unavailable, enable: unavailable, get: unavailable,
        install: unavailable, list: unavailable, reload: unavailable, remove: unavailable,
    };
}

const tui: TuiPageTransport = {
    action: async () => { throw new Error("Unexpected action."); },
    page: async () => ({ id: "alpha", title: "Alpha", lines: [], items: [] }),
    pages: async () => { throw new Error("Unexpected legacy catalog call."); },
};
const web: WebPageTransport = {
    action: async () => { throw new Error("Unexpected action."); },
    applications: async () => { throw new Error("Unexpected legacy catalog call."); },
    page: async () => { throw new Error("Unexpected page call."); },
    pages: async () => { throw new Error("Unexpected legacy catalog call."); },
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("snapshot precedes subscribe, concurrent refreshes coalesce, and close cancels in-flight reads", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const initial = deferred<ExtensionSnapshot>();
    const refresh = deferred<ExtensionSnapshot>();
    let reads = 0;
    const opened: number[] = [];
    const feed = new Feed();
    const model = new ExtensionViewModel(runtime(() => {
        reads += 1;
        return reads === 1 ? initial.promise : refresh.promise;
    }, async (revision) => { opened.push(revision); return feed; }), tui, web);
    const first = model.refreshCatalogs();
    const second = model.refreshCatalogs();
    assert.deepEqual(opened, []);
    assert.equal(reads, 1);
    initial.resolve(snapshot(4, ["alpha"]));
    await Promise.all([first, second]);
    assert.deepEqual(opened, [5]);
    await model.readTuiPage("alpha");
    assert.equal(model.state.tuiSnapshots.size, 1);
    feed.push({ kind: "event", event: { extensionIds: ["alpha"], revision: 5 } });
    feed.push({ kind: "event", event: { extensionIds: ["alpha"], revision: 6 } });
    await tick();
    context.mock.timers.tick(100);
    await tick();
    assert.equal(reads, 2);
    model.close();
    assert.equal(feed.closed, true);
    refresh.resolve(snapshot(6, ["beta"]));
    await tick();
    assert.deepEqual(model.state.extensions, []);
    assert.deepEqual(opened, [5]);
});

test("a burst refreshes once and ignores revisions already covered by the authoritative snapshot", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const feed = new Feed();
    let current = snapshot(2, ["alpha"]);
    let reads = 0;
    const model = new ExtensionViewModel(runtime(async () => {
        reads += 1;
        return current;
    }, async () => feed), tui, web);
    await model.refreshCatalogs();
    await model.readTuiPage("alpha");
    current = snapshot(5, ["beta"]);
    feed.push({ kind: "event", event: { extensionIds: ["alpha"], revision: 3 } });
    feed.push({ kind: "event", event: { extensionIds: ["alpha"], revision: 4 } });
    feed.push({ kind: "event", event: { extensionIds: ["beta"], revision: 5 } });
    await tick();
    assert.equal(reads, 1);
    context.mock.timers.tick(100);
    await tick();
    assert.equal(reads, 2);
    assert.equal(model.state.revision, 5);
    assert.deepEqual(model.state.extensions.map((record) => record.id), ["beta"]);
    assert.equal(model.state.tuiSnapshots.size, 0);
    feed.push({ kind: "event", event: { extensionIds: ["alpha"], revision: 4 } });
    await tick();
    context.mock.timers.tick(100);
    await tick();
    assert.equal(reads, 2);
    model.close();
});

test("gap refreshes authoritative catalogs, prunes page cache and resumes one past snapshot", async () => {
    const firstFeed = new Feed();
    const secondFeed = new Feed();
    const opened: number[] = [];
    let current = snapshot(2, ["alpha"]);
    const model = new ExtensionViewModel(runtime(async () => current, async (revision) => {
        opened.push(revision);
        return opened.length === 1 ? firstFeed : secondFeed;
    }), tui, web);
    await model.refreshCatalogs();
    await model.readTuiPage("alpha");
    current = snapshot(10, ["beta"]);
    firstFeed.push({ kind: "gap", gap: { fromSeq: 3, lastSeq: 10, nextSeq: 8 } });
    await tick();
    assert.deepEqual(opened, [3, 11]);
    assert.equal(firstFeed.closed, true);
    assert.equal(model.state.revision, 10);
    assert.deepEqual(model.state.extensions.map((record) => record.id), ["beta"]);
    assert.equal(model.state.tuiSnapshots.size, 0);
    assert.equal(model.state.webSupported, false);
    model.close();
    assert.equal(secondFeed.closed, true);
});

test("failed gap snapshot does not resume at an unverified revision", async () => {
    const feed = new Feed();
    let reads = 0;
    const opened: number[] = [];
    const model = new ExtensionViewModel(runtime(async () => {
        reads += 1;
        assert.ok(reads <= 2);
        if (reads === 2) throw new Error("snapshot unavailable");
        return snapshot(2);
    }, async (revision) => { opened.push(revision); return feed; }), tui, web);
    await model.refreshCatalogs();
    feed.push({ kind: "gap", gap: { fromSeq: 3, lastSeq: 10, nextSeq: 8 } });
    await tick();
    assert.deepEqual(opened, [3]);
    assert.equal(model.state.revision, 2);
    assert.equal(model.state.extensionsFailure?.message, "snapshot unavailable");
    model.close();
});

test("runtime transport requests the extension snapshot and decodes change/gap frames using the shared reader", async (context) => {
    const endpoint = new Endpoint({ host: "extension-client" });
    endpoint.connect = async (host, port) => endpoint.bind("extension-native").connect(host, port);
    const port = endpoint.bind("extension", "@control");
    const current = snapshot(4, ["alpha"]);
    const rpc = new Rpc(port, { snapshot: () => current });
    const streams = new Stream(port);
    const requests: unknown[] = [];
    streams.onOpen(async (stream, name, payload) => {
        requests.push({ name, payload });
        await tick();
        await stream.send({ name: "event", seq: 5, payload: { extensionIds: ["alpha"], revision: 5 } });
        await stream.send({ name: "gap", payload: { latestSeq: 10, oldestAvailableSeq: 8, requestedFromSeq: 6 } });
        await stream.send({ name: "event", seq: 11, payload: { extensionIds: [42], revision: 11 } });
    });
    context.after(() => { streams.close(); rpc.close(); endpoint.close(); });
    const transport = createExtensionRuntimeTransport(endpoint);
    assert.deepEqual(await transport.snapshot(), current);
    const subscription = await transport.subscribe(5);
    assert.deepEqual(await subscription.next(), { kind: "event", event: { extensionIds: ["alpha"], revision: 5 } });
    const gap = await subscription.next();
    assert.deepEqual(gap, {
        kind: "gap",
        gap: { fromSeq: 6, lastSeq: 10, nextSeq: 8 },
        details: { latestSeq: 10, oldestAvailableSeq: 8, requestedFromSeq: 6 },
    });
    await assert.rejects(subscription.next(), /Invalid Extension change event/);
    subscription.close();
    assert.deepEqual(requests, [{ name: "subscribe", payload: { fromRevision: 5 } }]);
});

test("mutation result survives an older in-flight snapshot and keeps retirement data out of the projection", async () => {
    const stale = deferred<ExtensionSnapshot>();
    const feed = new Feed();
    let reads = 0;
    const transport = runtime(() => {
        reads += 1;
        return reads === 2 ? stale.promise : Promise.resolve(snapshot(reads === 1 ? 2 : 3, reads === 1 ? ["alpha"] : ["alpha", "beta"]));
    }, async () => feed);
    transport.install = async () => ({ id: "beta", enabled: true, state: "active", retired: [{ generation: "old", inFlight: 1, state: "draining" }] });
    const model = new ExtensionViewModel(transport, tui, web);
    await model.refreshCatalogs();
    const refreshing = model.refreshCatalogs();
    assert.equal((await model.install("/source/beta")).id, "beta");
    assert.deepEqual(model.state.extensions.map((record) => record.id), ["alpha", "beta"]);
    assert.equal("retired" in model.state.extensions[1]!, false);
    stale.resolve(snapshot(2, ["alpha"]));
    await refreshing;
    assert.equal(reads, 3);
    assert.equal(model.state.revision, 3);
    assert.deepEqual(model.state.extensions.map((record) => record.id), ["alpha", "beta"]);
    model.close();
});

test("removed pages cannot be resurrected in caches by pending TUI reads or Web actions", async () => {
    const tuiRead = deferred<TuiPageSnapshot>();
    const webAction = deferred<WebPageSnapshot>();
    const feed = new Feed();
    let current: ExtensionSnapshot = {
        ...snapshot(2, ["alpha"]),
        webPages: [{ id: "alpha", extensionId: "alpha", title: "Alpha" }],
        webSupported: true,
    };
    const model = new ExtensionViewModel(
        runtime(async () => current, async () => feed),
        { ...tui, page: () => tuiRead.promise },
        { ...web, action: () => webAction.promise },
    );
    await model.refreshCatalogs();
    const pendingTui = model.readTuiPage("alpha");
    const pendingWeb = model.webAction("alpha", "update");
    current = snapshot(3);
    await model.refreshCatalogs();
    assert.deepEqual(model.state.tuiPages, []);
    assert.deepEqual(model.state.webPages, []);
    tuiRead.resolve({ items: [] });
    webAction.resolve({ tables: [] });
    assert.deepEqual(await pendingTui, { items: [] });
    assert.deepEqual(await pendingWeb, { tables: [] });
    assert.equal(model.state.tuiSnapshots.size, 0);
    assert.equal(model.state.webSnapshots.size, 0);
    model.close();
});
