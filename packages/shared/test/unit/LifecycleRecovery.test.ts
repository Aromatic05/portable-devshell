import assert from "node:assert/strict";
import test from "node:test";

import {
    EventSubscription,
    type EventStreamPort,
    type StreamMessage,
} from "../../src/client/Stream.ts";
import { AuthViewModel } from "../../src/control/auth/ViewModel.ts";
import { ExtensionViewModel } from "../../src/control/extension/ViewModel.ts";
import { ArtifactViewModel } from "../../src/execution/artifact/ViewModel.ts";
import { ToolCallViewModel } from "../../src/execution/toolcall/ViewModel.ts";
import { ContextViewModel } from "../../src/workspace/context/ViewModel.ts";
import { GoalViewModel } from "../../src/workspace/task/ViewModel.ts";

const tick = async () => await new Promise<void>((resolve) => setImmediate(resolve));

test("EventSubscription ignores an obsolete open after stop/start and closes the old stream", async () => {
    const openers: Array<(stream: EventStreamPort<number>) => void> = [];
    const delivered: number[] = [];
    const makeStream = () => {
        let closed = 0;
        let pending: ((message: StreamMessage<number>) => void) | undefined;
        const queue: StreamMessage<number>[] = [];
        const stream: EventStreamPort<number> = {
            next: async () => queue.shift() ?? await new Promise((resolve) => { pending = resolve; }),
            close: () => { closed += 1; pending?.({ kind: "closed" }); pending = undefined; },
        };
        const emit = (seq: number) => {
            const message: StreamMessage<number> = { kind: "event", event: seq };
            if (pending !== undefined) { const receive = pending; pending = undefined; receive(message); }
            else queue.push(message);
        };
        return { stream, emit, closed: () => closed };
    };
    const subscription = new EventSubscription<number>(1, {
        eventSeq: (event) => event,
        onEvent: (event) => delivered.push(event),
        onGap: () => 1,
        readGapError: () => undefined,
        open: async () => await new Promise((resolve) => openers.push(resolve)),
    });
    try {
        subscription.start();
        subscription.stop();
        subscription.start();
        const old = makeStream(), current = makeStream();
        assert.equal(openers.length, 2);
        openers[0]!(old.stream);
        openers[1]!(current.stream);
        await tick();
        old.emit(1);
        current.emit(1);
        await tick();
        assert.deepEqual(delivered, [1]);
        assert.equal(old.closed(), 1);
        subscription.stop();
        assert.ok(current.closed() >= 1);
    } finally {
        subscription.stop();
    }
});

test("Goal release fences an old request from a replacement with the same Instance name", async () => {
    let returnOld!: (snapshot: unknown) => void;
    let requests = 0;
    const vm = new GoalViewModel({ transport: () => ({
        async getGoals() {
            requests += 1;
            return requests === 1
                ? await new Promise((resolve) => { returnOld = resolve; })
                : { lastSeq: 2, goals: [{ goalId: "new" }] };
        },
        async subscribe() { return { next: async () => await new Promise<never>(() => {}), close() {} }; },
    } as never) });
    try {
        const stale = vm.refresh("alpha");
        vm.release("alpha");
        await vm.load("alpha");
        assert.equal(vm.state.instances.alpha?.goals[0]?.goalId, "new");
        returnOld({ lastSeq: 1, goals: [{ goalId: "old" }] });
        await stale;
        assert.equal(vm.state.instances.alpha?.goals[0]?.goalId, "new");
    } finally { vm.close(); }
});

test("ToolCall release fences old ledger results from a replacement Instance", async () => {
    let returnOld!: (calls: unknown[]) => void;
    let requests = 0;
    const transport = {
        async listCalls() {
            requests += 1;
            return requests === 1
                ? await new Promise<unknown[]>((resolve) => { returnOld = resolve; })
                : [{ callId: "new", startedAt: "2026-01-01T02:00:00Z", status: "completed" }];
        },
        async subscribe() { return { next: async () => await new Promise<never>(() => {}), close() {} }; },
    };
    const vm = new ToolCallViewModel({ cursor: async () => 2, transport: () => transport as never });
    try {
        const stale = vm.refresh("alpha");
        vm.release("alpha");
        await vm.load("alpha");
        returnOld([{ callId: "old", startedAt: "2026-01-01T01:00:00Z", status: "completed" }]);
        await stale;
        assert.deepEqual(vm.state.instances.alpha?.calls.map((call) => call.callId), ["new"]);
    } finally { vm.close(); }
});

test("Context refresh restores live subscription after initial snapshot failure", async () => {
    let reads = 0, subscriptions = 0;
    const vm = new ContextViewModel({
        async snapshot() {
            if (++reads === 1) throw new Error("temporary unavailable");
            return { revision: 7, contexts: [] };
        },
        async subscribe() {
            subscriptions += 1;
            return { next: async () => await new Promise<never>(() => {}), close() {} };
        },
    } as never);
    try {
        await vm.load();
        await vm.refresh();
        assert.equal(vm.state.revision, 7);
        assert.equal(subscriptions, 1);
    } finally { vm.close(); }
});

test("Goal refresh restores subscription after initial read failure", async () => {
    let reads = 0, subscriptions = 0;
    const vm = new GoalViewModel({ transport: () => ({
        async getGoals() {
            if (++reads === 1) throw new Error("temporary unavailable");
            return { lastSeq: 1, goals: [] };
        },
        async subscribe() {
            subscriptions += 1;
            return { next: async () => await new Promise<never>(() => {}), close() {} };
        },
    } as never) });
    try {
        await vm.load("alpha");
        await vm.refresh("alpha");
        assert.equal(subscriptions, 1);
    } finally { vm.close(); }
});

test("ToolCall refresh restores subscription after initial cursor read failure", async () => {
    let cursors = 0, subscriptions = 0;
    const vm = new ToolCallViewModel({
        cursor: async () => {
            if (++cursors === 1) throw new Error("temporary unavailable");
            return 3;
        },
        transport: () => ({
            async listCalls() { return []; },
            async subscribe() {
                subscriptions += 1;
                return { next: async () => await new Promise<never>(() => {}), close() {} };
            },
        } as never),
    });
    try {
        await vm.load("alpha");
        await vm.refresh("alpha");
        assert.equal(subscriptions, 1);
        assert.equal(cursors, 2);
    } finally { vm.close(); }
});

test("Context event bursts merge snapshot reads instead of superseding every in-flight result", async () => {
    let revision = 0, reads = 0;
    let finishRead!: () => void;
    let receive!: (message: StreamMessage<{ revision: number }>) => void;
    const delayed = new Promise<void>((resolve) => { finishRead = resolve; });
    const vm = new ContextViewModel({
        async snapshot() {
            reads += 1;
            if (reads === 2) await delayed;
            return { revision, contexts: [] };
        },
        async subscribe() {
            return {
                next: async () => await new Promise<StreamMessage<{ revision: number }>>((resolve) => { receive = resolve; }),
                close() { receive?.({ kind: "closed" }); },
            };
        },
    } as never);
    try {
        await vm.load();
        await tick();
        revision = 1;
        receive({ kind: "event", event: { revision } });
        await tick();
        assert.equal(reads, 2);
        for (let index = 2; index <= 20; index++) {
            revision = index;
            receive({ kind: "event", event: { revision } });
            await tick();
        }
        assert.equal(reads, 2);
        finishRead();
        await tick();
        await tick();
        assert.equal(vm.state.revision, 20);
        assert.equal(reads, 3);
    } finally { finishRead(); vm.close(); }
});

test("Auth load after an older pending read starts a fresh generation", async () => {
    let releaseOld!: (status: unknown) => void;
    let reads = 0;
    const vm = new AuthViewModel({
        async status() {
            return ++reads === 1
                ? await new Promise((resolve) => { releaseOld = resolve; })
                : { running: true, authMode: "none" };
        },
        async listApprovals() { return []; },
    } as never);
    try {
        const first = vm.refresh();
        const load = vm.load();
        releaseOld({ running: false });
        await Promise.all([first, load]);
        assert.equal(reads, 2);
        assert.equal(vm.state.status?.running, true);
    } finally { vm.close(); }
});

test("Artifact load from an older closed generation does not create another stream", async () => {
    let finishOld!: (snapshot: unknown) => void;
    let reads = 0, opens = 0, closes = 0;
    const vm = new ArtifactViewModel({
        async snapshot() {
            return ++reads === 1
                ? await new Promise((resolve) => { finishOld = resolve; })
                : { lastSeq: 4, shares: [], transfers: [] };
        },
        async subscribe() {
            opens += 1;
            return {
                next: async () => await new Promise<never>(() => {}),
                close() { closes += 1; },
            };
        },
    } as never);
    try {
        const old = vm.load();
        vm.close();
        await vm.load();
        await tick();
        finishOld({ lastSeq: 1, shares: [], transfers: [] });
        await old;
        await tick();
        assert.equal(opens, 1);
        vm.close();
        assert.equal(closes, 1);
    } finally { vm.close(); }
});

test("Extension accepts a new Control revision generation and resets its subscription", async () => {
    let revision = 20, id = "old";
    const cursors: number[] = [];
    const vm = new ExtensionViewModel({
        async snapshot() {
            return {
                revision,
                extensions: [{ id, enabled: true, state: "active" }],
                tuiPages: [], tuiSupported: true,
                webApplications: [], webPages: [], webSupported: true,
            };
        },
        async subscribe(fromRevision: number) {
            cursors.push(fromRevision);
            return { next: async () => await new Promise<never>(() => {}), close() {} };
        },
    } as never, {} as never, {} as never);
    try {
        await vm.refreshCatalogs();
        await tick();
        revision = 0;
        id = "new";
        await vm.refreshCatalogs();
        await tick();
        assert.equal(vm.state.revision, 0);
        assert.equal(vm.state.extensions[0]?.id, "new");
        assert.deepEqual(cursors, [21, 1]);
    } finally { vm.close(); }
});

test("ToolCall load from a removed generation cannot attach an old cursor to its replacement", async () => {
    let resolveOld!: (cursor: number) => void;
    let cursors = 0;
    const subscribedFrom: number[] = [];
    const vm = new ToolCallViewModel({
        cursor: async () => ++cursors === 1
            ? await new Promise<number>((resolve) => { resolveOld = resolve; })
            : 2,
        transport: () => ({
            async listCalls() { return []; },
            async subscribe(fromSeq: number) {
                subscribedFrom.push(fromSeq);
                return { next: async () => await new Promise<never>(() => {}), close() {} };
            },
        } as never),
    });
    try {
        const pending = vm.load("alpha");
        vm.release("alpha");
        await vm.load("alpha");
        resolveOld(50);
        await pending;
        assert.deepEqual(subscribedFrom, [3]);
    } finally { vm.close(); }
});

test("refreshing a deliberately stopped Goal or ToolCall does not revive its subscription", async () => {
    let goalSubscriptions = 0, toolSubscriptions = 0;
    const goals = new GoalViewModel({ transport: () => ({
        async getGoals() { return { lastSeq: 1, goals: [] }; },
        async subscribe() {
            goalSubscriptions += 1;
            return { next: async () => await new Promise<never>(() => {}), close() {} };
        },
    } as never) });
    const tools = new ToolCallViewModel({
        cursor: async () => 1,
        transport: () => ({
            async listCalls() { return []; },
            async subscribe() {
                toolSubscriptions += 1;
                return { next: async () => await new Promise<never>(() => {}), close() {} };
            },
        } as never),
    });
    try {
        await goals.load("alpha");
        await tools.load("alpha");
        goals.stop("alpha");
        tools.stop("alpha");
        await goals.refresh("alpha");
        await tools.refresh("alpha");
        assert.equal(goalSubscriptions, 1);
        assert.equal(toolSubscriptions, 1);
    } finally { goals.close(); tools.close(); }
});
