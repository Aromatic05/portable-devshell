import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type {
    ApprovalDecisionOptions,
    ApprovalDecisionValue,
    ApprovalEvent,
    ApprovalListResult,
    ApprovalRequest,
} from "../../src/workspace/approval/Model.ts";
import { ApprovalViewModel } from "../../src/workspace/approval/ViewModel.ts";
import type { StreamMessage } from "../../src/client/Stream.ts";
import { asInstanceName } from "../../src/types/Instance.ts";

test("a delayed snapshot cannot hide an approval already refreshed from the live event stream", { timeout: 5_000 }, async (t) => {
    const h = fixture(t);
    const stream = await h.load([request("old")], 1);
    const older = h.model.refresh();
    const oldReply = await h.snapshots.next();

    stream.messages.push(event(2));
    const newerReply = await h.snapshots.next();
    newerReply.resolve({ approvals: [request("latest")], lastSeq: 2 });
    await until(() => h.model.state.lastSeq === 2);
    const latest = h.model.state;
    oldReply.resolve({ approvals: [request("old")], lastSeq: 1 });
    await older;

    assert.equal(h.model.state, latest, "the stale reply must not publish or rewind the cursor");
    assert.deepEqual(ids(h.model), ["latest"]);
    assert.equal(h.model.state.status, "live");

    stream.messages.push(event(3));
    (await h.snapshots.next()).resolve({ approvals: [request("next")], lastSeq: 3 });
    await until(() => h.model.state.lastSeq === 3);
    assert.deepEqual(ids(h.model), ["next"]);
});

test("equal-sequence refreshes retain the response from the later read", async (t) => {
    const h = fixture(t);
    await h.load([request("old")], 1);
    const older = h.model.refresh();
    const oldReply = await h.snapshots.next();
    const newer = h.model.refresh();
    (await h.snapshots.next()).resolve({ approvals: [], lastSeq: 1 });
    await newer;
    const latest = h.model.state;
    oldReply.resolve({ approvals: [request("old")], lastSeq: 1 });
    await older;
    assert.equal(h.model.state, latest);
    assert.deepEqual(ids(h.model), []);
});

test("an older request carrying a higher sequence is still authoritative", async (t) => {
    const h = fixture(t);
    await h.load([], 1);
    const older = h.model.refresh();
    const oldReply = await h.snapshots.next();
    const newer = h.model.refresh();
    (await h.snapshots.next()).resolve({ approvals: [], lastSeq: 2 });
    await newer;
    oldReply.resolve({ approvals: [request("latest")], lastSeq: 3 });
    await older;
    assert.equal(h.model.state.lastSeq, 3);
    assert.deepEqual(ids(h.model), ["latest"]);
});

test("load subscribes after the newest accepted snapshot when a concurrent refresh wins", async (t) => {
    const h = fixture(t);
    const loading = h.model.load();
    const loadReply = await h.snapshots.next();
    const refreshing = h.model.refresh();
    (await h.snapshots.next()).resolve({ approvals: [request("latest")], lastSeq: 2 });
    await refreshing;
    loadReply.resolve({ approvals: [], lastSeq: 1 });
    await loading;
    const opened = await h.opened.next();
    assert.equal(opened.fromSeq, 3);
    assert.equal(h.model.state.lastSeq, 2);
    assert.deepEqual(ids(h.model), ["latest"]);
});

for (const decision of ["approve", "deny"] as const) {
    test(`${decision} cannot be undone by a same-sequence read started before the mutation`, async (t) => {
        const h = fixture(t);
        await h.load([request("review")], 1);
        const older = h.model.refresh();
        const oldReply = await h.snapshots.next();
        const delayed = h.model.refresh();
        const delayedReply = await h.snapshots.next();
        const options = { reason: "reviewed", remember: true };
        const deciding = h.model.decide("review", decision, options);
        const action = await h.decisions.next();
        assert.deepEqual(action.input, { approvalId: "review", decision, options });
        assert.deepEqual(ids(h.model), []);

        oldReply.resolve({ approvals: [request("review")], lastSeq: 1 });
        await older;
        assert.deepEqual(ids(h.model), [], "an in-flight decision must stay optimistically removed");

        const duringDecision = h.model.refresh();
        (await h.snapshots.next()).resolve({ approvals: [request("review"), request("other")], lastSeq: 1 });
        await duringDecision;
        assert.deepEqual(ids(h.model), ["other"], "refresh must retain other approvals while the decision is pending");
        const delayedDuringDecision = h.model.refresh();
        const duringReply = await h.snapshots.next();

        const decided = { ...request("review"), status: decision === "approve" ? "approved" as const : "denied" as const };
        action.reply.resolve(decided);
        assert.deepEqual(await deciding, decided);
        const beforeReconcile = h.model.state;
        (await h.snapshots.next()).resolve({ approvals: [], lastSeq: 1 });
        await until(() => h.model.state !== beforeReconcile);
        delayedReply.resolve({ approvals: [request("review")], lastSeq: 1 });
        await delayed;
        duringReply.resolve({ approvals: [request("review")], lastSeq: 1 });
        await delayedDuringDecision;
        assert.deepEqual(ids(h.model), []);
    });
}

test("a failed decision retains its error until a fresh authoritative read restores the request", async (t) => {
    const h = fixture(t);
    await h.load([request("review")], 1);
    const older = h.model.refresh();
    const oldReply = await h.snapshots.next();
    const deciding = h.model.decide("review", "deny");
    const failure = new Error("Policy revision 42 refused denial");
    const rejected = assert.rejects(deciding, failure);
    (await h.decisions.next()).reply.reject(failure);
    await rejected;
    const reconcile = await h.snapshots.next();
    oldReply.resolve({ approvals: [request("review")], lastSeq: 1 });
    await older;
    assert.equal(h.model.state.failure, failure);
    assert.deepEqual(ids(h.model), []);
    reconcile.resolve({ approvals: [request("review")], lastSeq: 1 });
    await until(() => h.model.state.failure === undefined);
    assert.deepEqual(ids(h.model), ["review"]);
});

test("gap recovery cannot rewind a newer refresh and remains reconnecting until the resumed stream opens", async (t) => {
    const h = fixture(t);
    const stream = await h.load([], 1);
    stream.messages.push(gap(2, 4));
    const recoveryReply = await h.snapshots.next();
    assert.equal(h.model.state.status, "reconnecting");
    const newer = h.model.refresh();
    (await h.snapshots.next()).resolve({ approvals: [request("latest")], lastSeq: 5 });
    await newer;
    const opening = h.holdNextOpen();
    recoveryReply.resolve({ approvals: [], lastSeq: 4 });
    const resumed = await h.opened.next();
    assert.equal(resumed.fromSeq, 6);
    assert.notEqual(h.model.state.status, "live", "a successful snapshot alone does not make the stream live");
    opening.resolve();
    await until(() => h.model.state.status === "live");
    assert.equal(stream.closed, true);
    assert.equal(h.model.state.lastSeq, 5);
    assert.deepEqual(ids(h.model), ["latest"]);
    resumed.stream.messages.push(event(6));
    (await h.snapshots.next()).resolve({ approvals: [request("after-gap")], lastSeq: 6 });
    await until(() => h.model.state.lastSeq === 6);
    assert.deepEqual(ids(h.model), ["after-gap"]);
});

test("closing during gap recovery prevents the late reply from publishing or reopening", async (t) => {
    const h = fixture(t);
    const stream = await h.load([], 1);
    stream.messages.push(gap(2, 4));
    const recoveryReply = await h.snapshots.next();
    h.model.close();
    const closed = h.model.state;
    recoveryReply.resolve({ approvals: [request("obsolete")], lastSeq: 4 });
    await turn();
    assert.equal(h.model.state, closed);
    assert.equal(h.model.state.status, "stopped");
    assert.equal(stream.closed, true);
    assert.equal(h.openCount(), 1);
});

test("reload accepts a restarted instance's lower sequence and fences its old recovery", async (t) => {
    const h = fixture(t);
    const stream = await h.load([request("old")], 20);
    stream.messages.push(gap(21, 24));
    const recoveryReply = await h.snapshots.next();
    const loading = h.model.load();
    (await h.snapshots.next()).resolve({ approvals: [request("restarted")], lastSeq: 1 });
    await loading;
    recoveryReply.resolve({ approvals: [request("obsolete")], lastSeq: 24 });
    await turn();
    assert.equal(h.model.state.lastSeq, 1);
    assert.deepEqual(ids(h.model), ["restarted"]);
    assert.equal(stream.closed, true);
    assert.equal((await h.opened.next()).fromSeq, 2);
    await until(() => h.model.state.status === "live");
});

test("a failed reload keeps the current subscription usable until a fresh snapshot can replace it", async (t) => {
    const h = fixture(t);
    const stream = await h.load([request("current")], 1);
    const loading = h.model.load();
    const rejected = assert.rejects(loading, /reload unavailable/u);
    (await h.snapshots.next()).reject(new Error("reload unavailable"));
    await rejected;
    assert.equal(stream.closed, false);
    assert.equal(h.model.state.status, "live");
    assert.deepEqual(ids(h.model), ["current"]);
    stream.messages.push(event(2));
    (await h.snapshots.next()).resolve({ approvals: [request("next")], lastSeq: 2 });
    await until(() => h.model.state.lastSeq === 2);
    assert.deepEqual(ids(h.model), ["next"]);
});

test("a fresh equal-sequence snapshot remains usable and filters terminal approvals", async (t) => {
    const h = fixture(t);
    await h.load([], 1);
    const refreshing = h.model.refresh();
    (await h.snapshots.next()).resolve({ approvals: [request("pending"), { ...request("done"), status: "approved" }], lastSeq: 1 });
    await refreshing;
    assert.deepEqual(ids(h.model), ["pending"]);
    assert.deepEqual(await h.model.get("pending"), request("pending"));
});

test("an interrupted live stream reconnects from its consumed cursor and delivers the next approval", { timeout: 5_000 }, async (t) => {
    const h = fixture(t);
    const stream = await h.load([], 1);
    stream.messages.push(event(2));
    (await h.snapshots.next()).resolve({ approvals: [request("current")], lastSeq: 2 });
    await until(() => h.model.state.lastSeq === 2);
    stream.messages.push({ kind: "closed" });
    await until(() => stream.closed);
    const resumed = await h.opened.next();
    assert.equal(resumed.fromSeq, 3);
    resumed.stream.messages.push(event(3));
    (await h.snapshots.next()).resolve({ approvals: [request("next")], lastSeq: 3 });
    await until(() => h.model.state.lastSeq === 3);
    assert.deepEqual(ids(h.model), ["next"]);
    assert.equal(h.model.state.status, "live");
});

test("failed gap recovery stays reconnecting and retries without skipping the missing events", { timeout: 5_000 }, async (t) => {
    const h = fixture(t);
    const stream = await h.load([request("current")], 1);
    stream.messages.push(gap(2, 4));
    (await h.snapshots.next()).reject(new Error("snapshot temporarily unavailable"));
    await until(() => stream.closed);
    assert.equal(h.model.state.status, "reconnecting");
    assert.deepEqual(ids(h.model), ["current"]);
    assert.equal(h.model.state.lastSeq, 1);
    const retried = await h.opened.next();
    assert.equal(retried.fromSeq, 2);
    retried.stream.messages.push(gap(2, 4));
    (await h.snapshots.next()).resolve({ approvals: [request("recovered")], lastSeq: 4 });
    assert.equal((await h.opened.next()).fromSeq, 5);
    await until(() => h.model.state.status === "live");
    assert.deepEqual(ids(h.model), ["recovered"]);
});

test("late initial load and refresh replies cannot repopulate a closed projection", async (t) => {
    const h = fixture(t);
    const loading = h.model.load();
    const loadReply = await h.snapshots.next();
    const refreshing = h.model.refresh();
    const refreshReply = await h.snapshots.next();
    h.model.close();
    const closed = h.model.state;
    loadReply.resolve({ approvals: [request("obsolete-load")], lastSeq: 8 });
    refreshReply.resolve({ approvals: [request("obsolete-refresh")], lastSeq: 9 });
    await loading;
    await refreshing;
    assert.equal(h.model.state, closed);
    assert.equal(h.openCount(), 0);
});

for (const outcome of ["success", "failure"] as const) {
    test(`a late decision ${outcome} cannot affect a replacement lifecycle`, async (t) => {
        const h = fixture(t);
        await h.load([request("review")], 10);
        const deciding = h.model.decide("review", "approve");
        const completed = outcome === "failure" ? assert.rejects(deciding, /old decision failed/u) : deciding;
        const action = await h.decisions.next();
        h.model.close();
        await h.load([request("replacement")], 1);
        const replacement = h.model.state;
        if (outcome === "failure") action.reply.reject(new Error("old decision failed"));
        else action.reply.resolve({ ...request("review"), status: "approved" });
        await completed;
        await turn();
        assert.equal(h.model.state, replacement);
        assert.equal(h.snapshotCount(), 2, "the old decision must not refresh the replacement lifecycle");
    });
}

function fixture(t: TestContext) {
    const snapshots = new Queue<Deferred<ApprovalListResult>>();
    const decisions = new Queue<{
        input: { approvalId: string; decision: ApprovalDecisionValue; options?: ApprovalDecisionOptions };
        reply: Deferred<ApprovalRequest>;
    }>();
    const opened = new Queue<{ fromSeq: number; stream: ControlledStream }>();
    let openCount = 0;
    let snapshotCount = 0;
    let nextOpen: Deferred<void> | undefined;
    const model = new ApprovalViewModel({
        snapshot: async (options) => {
            assert.deepEqual(options, { pendingOnly: true });
            snapshotCount += 1;
            const reply = deferred<ApprovalListResult>();
            snapshots.push(reply);
            return await reply.promise;
        },
        decide: async (approvalId, decision, options) => {
            const reply = deferred<ApprovalRequest>();
            decisions.push({ input: { approvalId, decision, options }, reply });
            return await reply.promise;
        },
        get: async (approvalId) => request(approvalId),
        list: async () => [],
        subscribe: async (fromSeq) => {
            const stream = new ControlledStream();
            const opening = nextOpen;
            nextOpen = undefined;
            openCount += 1;
            opened.push({ fromSeq, stream });
            await opening?.promise;
            return stream;
        },
    });
    t.after(() => model.close());
    return {
        model, snapshots, decisions, opened,
        openCount: () => openCount,
        snapshotCount: () => snapshotCount,
        holdNextOpen() {
            const opening = deferred<void>();
            nextOpen = opening;
            return opening;
        },
        async load(approvals: ApprovalRequest[], lastSeq: number) {
            const loading = model.load();
            (await snapshots.next()).resolve({ approvals, lastSeq });
            await loading;
            const { stream, fromSeq } = await opened.next();
            assert.equal(fromSeq, lastSeq + 1);
            await until(() => model.state.status === "live");
            return stream;
        },
    };
}

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

class Queue<T> {
    readonly #values: T[] = [];
    readonly #waiters: Array<(value: T) => void> = [];

    push(value: T): void {
        const waiter = this.#waiters.shift();
        if (waiter === undefined) this.#values.push(value);
        else waiter(value);
    }

    async next(): Promise<T> {
        const value = this.#values.shift();
        if (value !== undefined) return value;
        return await new Promise<T>((resolve) => this.#waiters.push(resolve));
    }
}

class ControlledStream {
    readonly messages = new Queue<StreamMessage<ApprovalEvent>>();
    closed = false;

    next() { return this.messages.next(); }
    close() { this.closed = true; this.messages.push({ kind: "closed" }); }
}

function request(approvalId: string): ApprovalRequest {
    return {
        approvalId, callId: `call-${approvalId}`, instance: asInstanceName("alpha"),
        createdAt: "2026-10-20T00:00:00.000Z", expiresAt: "2026-10-20T00:05:00.000Z",
        inputSummary: "deploy", reason: "Review deployment", riskLevel: "high",
        source: "web", status: "pending", toolName: "deploy",
    };
}

function event(seq: number): StreamMessage<ApprovalEvent> {
    return { kind: "event", event: {
        seq, instanceName: asInstanceName("alpha"), type: "approval.requested", at: "2026-10-20T00:00:00.000Z",
    } };
}

function gap(fromSeq: number, lastSeq: number): StreamMessage<ApprovalEvent> {
    return { kind: "gap", gap: { fromSeq, lastSeq, nextSeq: lastSeq } };
}

function ids(model: ApprovalViewModel): string[] {
    return model.state.approvals.map(({ approvalId }) => approvalId);
}

async function turn(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

async function until(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 1_000 && !predicate(); attempt += 1) await turn();
    assert.equal(predicate(), true, "expected projection transition");
}
