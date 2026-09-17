import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    ControlReadModel,
    type ContextMessageRecord,
    type ControlClients,
    type InstanceSnapshot,
} from "@portable-devshell/shared";

const snapshot = (name: string, lastSeq: number): InstanceSnapshot => ({
    connectionState: "connected",
    daemonState: "running",
    lastSeq,
    name: asInstanceName(name),
    ready: true,
    status: "ready",
});

const message: ContextMessageRecord = {
    createdAt: "2026-09-17T00:00:00.000Z",
    ctxId: "ctx-alpha",
    id: "message-alpha",
    instance: "alpha",
    status: "pending",
    text: "continue",
};

test("read model preserves unchanged instance and heavy-array identities across unrelated updates", () => {
    const model = new ControlReadModel({ clients: {} as ControlClients });

    model.mergeQueuedContextMessage("alpha", message);
    const before = model.state;
    const alphaBefore = before.instanceState.alpha!;

    model.applyAuthoritativeSnapshot(snapshot("beta", 2));
    const after = model.state;

    assert.equal(after.instanceState.alpha, alphaBefore);
    assert.equal(
        after.instanceState.alpha?.conversationEntries,
        alphaBefore.conversationEntries,
    );
    assert.equal(after.instanceState.alpha?.logs, alphaBefore.logs);
    assert.equal(after.instanceState.alpha?.toolCalls, alphaBefore.toolCalls);
});

test("read model keeps unchanged heavy arrays when the same instance snapshot changes", () => {
    const model = new ControlReadModel({ clients: {} as ControlClients });

    model.mergeQueuedContextMessage("alpha", message);
    const before = model.state.instanceState.alpha!;

    model.applyAuthoritativeSnapshot(snapshot("alpha", 3));
    const after = model.state.instanceState.alpha!;

    assert.notEqual(after, before);
    assert.equal(after.conversationEntries, before.conversationEntries);
    assert.equal(after.contextMessages, before.contextMessages);
    assert.equal(after.logs, before.logs);
    assert.equal(after.toolCalls, before.toolCalls);
});
