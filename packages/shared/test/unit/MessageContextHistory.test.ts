import assert from "node:assert/strict";
import test from "node:test";

import { MessageHistoryViewModel } from "../../src/workspace/message/ViewModel.ts";
import type { MessageEntry, MessageListInput } from "../../src/workspace/message/Model.ts";
import type { MessageTransport } from "../../src/workspace/message/Transport.ts";

function entry(index: number, ctxId: string): MessageEntry {
    return {
        id: `message-${index}`, ctxId, kind: "comment", status: "delivered",
        createdAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
        text: `Message ${index}`,
    };
}

test("Context messages paginate independently of the Instance's newest 400 entries", async (t) => {
    const all = Array.from({ length: 30 * 430 }, (_, i) => entry(i, `ctx-${i % 30}`));
    const queries: MessageListInput[] = [];
    const model = new MessageHistoryViewModel({
        transport: {
            listMessageEntries: async (_instance: string, query: MessageListInput = {}) => {
                queries.push(query);
                const scoped = all.filter((item) => query.ctxId === undefined || item.ctxId === query.ctxId);
                const before = query.before === undefined
                    ? scoped.length : scoped.findIndex((item) => item.id === query.before);
                return { entries: scoped.slice(0, Math.max(0, before)).slice(-(query.limit ?? 400)), lastSeq: all.length };
            },
        } as unknown as MessageTransport,
    });
    t.after(() => model.close());

    await model.refreshInstance("demo");
    assert.equal(model.state.instances.demo.entries.length, 400);
    assert.ok(model.state.instances.demo.entries.filter((item) => item.ctxId === "ctx-7").length < 20);

    await model.loadContext("demo", "ctx-7");
    assert.equal(model.state.context?.entries.length, 400);
    assert.equal(queries.at(-1)?.ctxId, "ctx-7");
    assert.equal(await model.loadOlderContext("demo", "ctx-7"), 30);
    assert.equal(model.state.context?.entries.length, 430);
    assert.equal(new Set(model.state.context?.entries.map((item) => item.id)).size, 430);
    assert.equal(await model.loadOlderContext("demo", "ctx-7"), 0);
    assert.equal(model.state.context?.historyExhausted, true);
    assert.equal(model.state.instances.demo.entries.length, 400,
        "Scoped history must not expand the Instance preview");
});

test("late Context pages cannot append to a different Context or a reopened Context", async (t) => {
    const records = [entry(1, "ctx-a"), entry(2, "ctx-a"), entry(3, "ctx-b")];
    let resolveOld!: (value: { entries: MessageEntry[]; lastSeq: number }) => void;
    const oldPage = new Promise<{ entries: MessageEntry[]; lastSeq: number }>((resolve) => {
        resolveOld = resolve;
    });
    let reads = 0;
    const model = new MessageHistoryViewModel({
        transport: {
            listMessageEntries: async (_instance: string, query: MessageListInput = {}) => {
                if (query.before !== undefined) {
                    reads++;
                    return reads === 1 ? await oldPage : { entries: [entry(0, "ctx-a")], lastSeq: 5 };
                }
                return { entries: records.filter((item) => item.ctxId === query.ctxId), lastSeq: 5 };
            },
        } as unknown as MessageTransport,
    });
    t.after(() => model.close());
    await model.loadContext("demo", "ctx-a");
    const pending = model.loadOlderContext("demo", "ctx-a");
    await model.loadContext("demo", "ctx-b");
    assert.equal(model.state.context?.ctxId, "ctx-b");
    resolveOld({ entries: [entry(0, "ctx-a")], lastSeq: 5 });
    assert.equal(await pending, 0);
    assert.deepEqual(model.state.context?.entries.map((item) => item.id), ["message-3"]);

    await model.loadContext("demo", "ctx-a");
    assert.equal(await model.loadOlderContext("demo", "ctx-a"), 1);
    assert.deepEqual(model.state.context?.entries.map((item) => item.id),
        ["message-0", "message-1", "message-2"]);
    model.clearContext("demo", "ctx-a");
    assert.equal(model.state.context, undefined);
});

test("paged Context refresh bridges more than 400 new messages and preserves the older cursor", async (t) => {
    const all = Array.from({ length: 850 }, (_, i) => entry(i, "ctx-a"));
    const model = new MessageHistoryViewModel({ transport: {
        listMessageEntries: async (_instance: string, query: MessageListInput = {}) => {
            const end = query.before === undefined ? all.length : all.findIndex((item) => item.id === query.before);
            return { entries: all.slice(0, end).slice(-(query.limit ?? 400)), lastSeq: all.length };
        },
    } as unknown as MessageTransport });
    t.after(() => model.close());
    await model.loadContext("demo", "ctx-a");
    assert.equal(await model.loadOlderContext("demo", "ctx-a"), 400);
    assert.equal(model.state.context?.historyBefore, "message-50");
    all.push(...Array.from({ length: 950 }, (_, i) => entry(i + 850, "ctx-a")));
    await model.loadContext("demo", "ctx-a");
    assert.deepEqual(model.state.context?.entries.map((item) => item.id), all.slice(50).map((item) => item.id));
    assert.equal(model.state.context?.historyBefore, "message-50");
    assert.equal(await model.loadOlderContext("demo", "ctx-a"), 50);
    assert.equal(await model.loadOlderContext("demo", "ctx-a"), 0);
    assert.equal(model.state.context?.historyExhausted, true);
    assert.deepEqual(model.state.context?.entries.map((item) => item.id), all.map((item) => item.id));
    all.push(...Array.from({ length: 450 }, (_, i) => entry(i + 1800, "ctx-a")));
    await model.loadContext("demo", "ctx-a");
    assert.equal(model.state.context?.historyExhausted, true);
    assert.equal(model.state.context?.historyBefore, "message-0");
    assert.deepEqual(model.state.context?.entries.map((item) => item.id), all.map((item) => item.id));
});
