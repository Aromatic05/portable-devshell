import assert from "node:assert/strict";
import test from "node:test";
import { asInstanceName, Endpoint, ProcessSubscriptionManager, Rpc, Stream, type ControlPortContext } from "@portable-devshell/shared";
import { createMcpAppViewModel } from "../../src/mcpapp/ViewModel.ts";

for (const owners of [
    Array.from({ length: 1000 }, () => "other"),
    ["other", "viewed", "other"],
    ["other", "global", "other"],
]) test(`Watch coalesces seed with ${owners.length} events (${owners[1]})`, async (t) => {
    const endpoint = new Endpoint({ host: "watch-batch" });
    endpoint.connect = async (host, port) => endpoint.bind(`client-${port}`).connect(host, port);
    let subscriptions = 0;
    let closed = 0;
    let stateReads = 0;
    let sourceReads = 0;
    let seedEvents = 0;
    const manager = new ProcessSubscriptionManager(1000);
    const task = new Rpc(endpoint.bind("task", "alpha"), {
        getGoal: (query) => {
            assert.deepEqual(query, { ctxId: "viewed" });
            stateReads++;
            return { goal: null, lastSeq: owners.length };
        },
        getWaits: () => ({ waits: [], lastSeq: owners.length }),
    });
    const approval = new Rpc(endpoint.bind("approval", "alpha"), {
        snapshot: () => ({ approvals: [], lastSeq: owners.length }),
    });
    const tool = new Rpc(endpoint.bind("tool", "alpha"), { listCalls: () => [] });
    const events = new Stream(endpoint.bind("instance", "alpha"));
    events.onOpen(async (stream, name, message) => {
        assert.equal(name, "subscribeEvents");
        subscriptions++;
        stream.onClose(() => closed++);
        const source = { subscribe(fromSeq = 1) {
            sourceReads++;
            const batch = owners.map((owner, index) => ({
                at: "", instanceName: asInstanceName("alpha"), seq: index + 1,
                type: owner === "global" ? "instance.started" : "toolCall.completed",
                data: { ctxId: owner },
            })).filter((event) => event.seq >= fromSeq);
            seedEvents += batch.length;
            return { kind: "events" as const, events: batch, lastSeq: owners.length };
        } };
        await manager.subscribe(stream,
            { connectionId: "browser", requestId: stream.id } as ControlPortContext,
            "alpha", source, (message as { fromSeq: number }).fromSeq);
    });
    t.after(() => { manager.close(); events.close(); tool.close(); approval.close(); task.close(); endpoint.close(); });
    const result = await createMcpAppViewModel(endpoint).watch("alpha", "viewed", undefined, 0);
    const relevant = owners.includes("viewed") || owners.includes("global");
    assert.equal(result.cursor, owners.length);
    assert.equal(result.changed, relevant);
    assert.equal(stateReads, Number(relevant));
    assert.equal(subscriptions, 1);
    assert.equal(sourceReads, 1);
    assert.equal(seedEvents, owners.length);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, 1);
});

test("Watch aborts during foreign live events and closes its sole subscription", async (t) => {
    const endpoint = new Endpoint({ host: "watch-abort" });
    endpoint.connect = async (host, port) => endpoint.bind(`client-${port}`).connect(host, port);
    const events = new Stream(endpoint.bind("instance", "alpha"));
    const controller = new AbortController();
    let closed = 0;
    events.onOpen(async (stream) => {
        stream.onClose(() => closed++);
        await stream.send({ name: "event", payload: {
            at: "", instanceName: "alpha", seq: 1,
            type: "toolCall.completed", data: { ctxId: "other" },
        } });
        setTimeout(() => controller.abort(), 5);
    });
    t.after(() => { events.close(); endpoint.close(); });
    const result = await createMcpAppViewModel(endpoint).watch("alpha", "viewed", undefined, 0, controller.signal);
    assert.deepEqual(result, { changed: false, cursor: 0 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, 1);
});


test("Watch closes a subscription opened after its Host request was already aborted", async (t) => {
    const endpoint = new Endpoint({ host: "watch-opening-abort" });
    const controller = new AbortController();
    let release!: () => void;
    const opening = new Promise<void>((resolve) => { release = resolve; });
    endpoint.connect = async (host, port) => {
        await opening;
        return endpoint.bind(`client-${port}`).connect(host, port);
    };
    const events = new Stream(endpoint.bind("instance", "alpha"));
    let closed = 0;
    events.onOpen((stream) => { stream.onClose(() => closed++); });
    t.after(() => { events.close(); endpoint.close(); });
    const pending = createMcpAppViewModel(endpoint).watch("alpha", "viewed", undefined, 0, controller.signal);
    controller.abort();
    release();
    assert.deepEqual(await pending, { changed: false, cursor: 0 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, 1);
});
