import assert from "node:assert/strict";
import test from "node:test";

import { AuthViewModel } from "../../src/control/auth/ViewModel.ts";
import { InstanceConfigViewModel } from "../../src/control/instance/ViewModel.ts";
import { OverviewViewModel } from "../../src/control/overview/ViewModel.ts";
import { ProcessViewModel } from "../../src/execution/process/ViewModel.ts";
import { ToolCallViewModel } from "../../src/execution/toolcall/ViewModel.ts";
import { MessageHistoryViewModel, MessageViewModel } from "../../src/workspace/message/ViewModel.ts";

const tick = async () => await new Promise<void>((resolve) => setImmediate(resolve));
const message = { id: "old-comment", instance: "alpha", ctxId: "old", text: "OLD", status: "pending", createdAt: "2026-01-01T00:00:00Z" };
const entry = { id: "old-comment", ctxId: "old", kind: "comment", text: "OLD", status: "pending", createdAt: "2026-01-01T00:00:00Z" };

for (const kind of ["message", "history"] as const) {
    test(`${kind} release retires old subscriptions, cursors and pending entries before same-name recreation`, async () => {
        let generation = 0, opened = 0, closed = 0;
        const transport = {
            async listContextMessages() { return generation === 0 ? { lastSeq: 99, messages: [message] } : { lastSeq: 0, messages: [] }; },
            async listMessageEntries() { return generation === 0 ? { lastSeq: 99, entries: [entry] } : { lastSeq: 0, entries: [] }; },
            async subscribe() { opened++; return { next: async () => await new Promise<never>(() => {}), close() { closed++; } }; },
        };
        const vm = kind === "message"
            ? new MessageViewModel({ transport: transport as never })
            : new MessageHistoryViewModel({ transport: transport as never });
        try {
            await vm.load(["alpha"]);
            await tick();
            assert.equal(vm.state.instances.alpha?.lastSeq, 99);
            assert.equal(opened, 1);
            vm.release("alpha");
            assert.equal(vm.state.instances.alpha, undefined);
            generation = 1;
            await vm.load(["alpha"]);
            assert.equal((vm.state.instances as Record<string, { lastSeq: number }>).alpha?.lastSeq, 0);
            assert.equal(closed, 1);
            assert.equal(opened, 2);
            if (kind === "message") assert.deepEqual((vm as MessageViewModel).state.instances.alpha?.messages, []);
            else assert.deepEqual((vm as MessageHistoryViewModel).state.instances.alpha?.entries, []);
        } finally { vm.close(); }
    });

    test(`${kind} last-finishing old load cannot retire streams created by newer catalog`, async () => {
        let firstResolve!: (data: unknown) => void;
        let reads = 0;
        const closed: string[] = [];
        const transport = {
            async listContextMessages(instance: string) {
                if (instance === "alpha" && ++reads === 1)
                    return await new Promise((resolve) => { firstResolve = resolve; });
                return { lastSeq: 1, messages: [] };
            },
            async listMessageEntries(instance: string) {
                if (instance === "alpha" && ++reads === 1)
                    return await new Promise((resolve) => { firstResolve = resolve; });
                return { lastSeq: 1, entries: [] };
            },
            async subscribe(instance: string) {
                return { next: async () => await new Promise<never>(() => {}), close() { closed.push(instance); } };
            },
        };
        const vm = kind === "message"
            ? new MessageViewModel({ transport: transport as never })
            : new MessageHistoryViewModel({ transport: transport as never });
        try {
            const old = vm.load(["alpha"]);
            await vm.load(["alpha", "beta"]);
            await tick();
            firstResolve(kind === "message" ? { lastSeq: 0, messages: [] } : { lastSeq: 0, entries: [] });
            await old;
            assert.equal(vm.state.instances.beta?.status, "live");
            assert.deepEqual(closed, []);
        } finally { vm.close(); }
    });

    test(`${kind} recovers its requested stream when first snapshot failed`, async () => {
        let reads = 0, opens = 0;
        const transport = {
            async listContextMessages() { if (++reads === 1) throw new Error("temporary"); return { lastSeq: 3, messages: [] }; },
            async listMessageEntries() { if (++reads === 1) throw new Error("temporary"); return { lastSeq: 3, entries: [] }; },
            async subscribe() { opens++; return { next: async () => await new Promise<never>(() => {}), close() {} }; },
        };
        const vm = kind === "message"
            ? new MessageViewModel({ transport: transport as never })
            : new MessageHistoryViewModel({ transport: transport as never });
        try {
            await vm.load(["alpha"]);
            await vm.refreshInstance("alpha");
            await tick();
            assert.equal(opens, 1);
            assert.equal(vm.state.instances.alpha?.lastSeq, 3);
            assert.equal(vm.state.instances.alpha?.status, "live");
        } finally { vm.close(); }
    });
}

test("a queued Comment from the deleted Instance cannot repopulate its replacement", async () => {
    let finishOld!: (value: unknown) => void;
    const vm = new MessageViewModel({ transport: {
        async listContextMessages() { return { lastSeq: 0, messages: [] }; },
        async queueContextMessage() { return await new Promise((resolve) => { finishOld = resolve; }); },
    } as never });
    try {
        const old = vm.queue("alpha", "old", "OLD");
        vm.release("alpha");
        await vm.refreshInstance("alpha");
        finishOld(message);
        await old;
        assert.deepEqual(vm.state.instances.alpha?.messages, []);
    } finally { vm.close(); }
});

const snapshot = (seq: number, status: "running" | "stopped") => ({
    lastSeq: seq, snapshot: { name: "alpha", lastSeq: seq, status, ready: true, daemonState: "running", connectionState: "connected" },
});

test("Process rejects out-of-order snapshot and log RPC completions", async () => {
    let oldSnapshot!: (value: unknown) => void, oldLogs!: (value: unknown) => void;
    let reads = 0, logReads = 0;
    const vm = new ProcessViewModel({
        async refresh() { return ++reads === 1 ? await new Promise((resolve) => { oldSnapshot = resolve; }) : snapshot(10, "running"); },
        async readLogs() { return ++logReads === 1 ? await new Promise((resolve) => { oldLogs = resolve; }) : [{ message: "NEW" }]; },
    } as never);
    try {
        const first = vm.refresh();
        await vm.refresh();
        oldSnapshot(snapshot(1, "stopped"));
        await first;
        assert.equal(vm.state.lastSeq, 10);
        assert.equal(vm.state.snapshot?.status, "running");
        const earlier = vm.readLogs();
        await vm.readLogs();
        oldLogs([{ message: "OLD" }]);
        await earlier;
        assert.equal(vm.state.logs[0]?.message, "NEW");
    } finally { vm.close(); }
});

test("Process recovery after close never re-creates its discarded snapshot", async () => {
    let resolveGap!: (value: unknown) => void, resolveSnapshot!: (value: unknown) => void;
    let reads = 0;
    const vm = new ProcessViewModel({
        async refresh() { return ++reads === 1 ? snapshot(1, "running") : await new Promise((resolve) => { resolveSnapshot = resolve; }); },
        async subscribe() { return { next: async () => await new Promise((resolve) => { resolveGap = resolve; }), close() {} }; },
    } as never);
    await vm.load();
    await tick();
    resolveGap({ kind: "gap", gap: { fromSeq: 2, nextSeq: 3, lastSeq: 4 } });
    await tick();
    vm.close();
    resolveSnapshot(snapshot(12, "stopped"));
    await tick();
    assert.equal(vm.state.snapshot, undefined);
    assert.equal(vm.state.lastSeq, 0);
});

test("Process initial failure then refresh attaches the missing live stream", async () => {
    let reads = 0, opens = 0;
    const vm = new ProcessViewModel({
        async refresh() { if (++reads === 1) throw new Error("offline"); return snapshot(3, "running"); },
        async subscribe() { opens++; return { next: async () => await new Promise<never>(() => {}), close() {} }; },
    } as never);
    try {
        await assert.rejects(vm.load(), /offline/);
        await vm.refresh();
        await tick();
        assert.equal(opens, 1);
        assert.equal(vm.state.connection, "live");
    } finally { vm.close(); }
});

test("ToolCall old gap cursor cannot recreate an Instance after release", async () => {
    let nextEvent!: (event: unknown) => void, resolveCursor!: (seq: number) => void;
    let cursorReads = 0, listReads = 0;
    const vm = new ToolCallViewModel({
        cursor: async () => ++cursorReads === 1 ? 1 : await new Promise((resolve) => { resolveCursor = resolve; }),
        transport: () => ({
            async listCalls() { listReads++; return []; },
            async subscribe() { return { next: async () => await new Promise((resolve) => { nextEvent = resolve; }), close() {} }; },
        } as never),
    });
    try {
        await vm.load("alpha");
        await tick();
        nextEvent({ kind: "gap", gap: { fromSeq: 2, lastSeq: 4, nextSeq: 3 } });
        await tick();
        vm.release("alpha");
        resolveCursor(99);
        await tick();
        assert.equal(vm.state.instances.alpha, undefined);
        assert.equal(listReads, 1);
    } finally { vm.close(); }
});

test("Auth and Overview time out their hanging RPC and cancel it before the next refresh", async () => {
    let authReads = 0, authAborted = 0;
    const auth = new AuthViewModel({
        async status(signal?: AbortSignal) {
            if (++authReads === 1) return await new Promise<never>((_resolve, reject) => {
                signal?.addEventListener("abort", () => { authAborted++; reject(new Error("cancelled")); }, { once: true });
            });
            return { running: true, authMode: "none" };
        },
        async listApprovals() { return []; },
    } as never, { requestTimeoutMs: 10, pollIntervalMs: 0 });
    try {
        await auth.refresh();
        await auth.refresh();
        assert.equal(authReads, 2);
        assert.equal(authAborted, 1);
        assert.equal(auth.state.status?.running, true);
    } finally { auth.close(); }

    let overviewReads = 0, overviewAborted = 0;
    const overview = new OverviewViewModel({
        async get(signal?: AbortSignal) {
            if (++overviewReads === 1) return await new Promise<never>((_resolve, reject) => {
                signal?.addEventListener("abort", () => { overviewAborted++; reject(new Error("cancelled")); }, { once: true });
            });
            return {};
        },
    } as never, { requestTimeoutMs: 10, refreshIntervalMs: 0 });
    try {
        await overview.refresh();
        await overview.refresh();
        assert.equal(overviewReads, 2);
        assert.equal(overviewAborted, 1);
        assert.equal(overview.state.status, "ready");
    } finally { overview.close(); }
});

test("cancelling an Audit catalog read clears the Instance refreshing indicator without publishing an error", async () => {
    let reads = 0;
    const vm = new InstanceConfigViewModel({
        async snapshotInstances(signal?: AbortSignal) {
            if (++reads === 1) return { revision: 1, instances: [] };
            return await new Promise<never>((_resolve, reject) => {
                signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
            });
        },
        async subscribeInstances() {
            return { next: async () => await new Promise<never>(() => {}), close() {} };
        },
    } as never);
    try {
        await vm.list();
        const abort = new AbortController();
        const pending = vm.refresh(abort.signal);
        assert.equal(vm.state.refreshing, true);
        abort.abort();
        await pending;
        assert.equal(vm.state.refreshing, false);
        assert.equal(vm.state.loading, false);
        assert.equal(vm.state.failure, undefined);
    } finally { vm.close(); }
});

for (const kind of ["message", "history"] as const) {
    test(`${kind} does not publish a failed read when Audit has cancelled the request`, async () => {
        const transport = {
            async listContextMessages(_instance: string, _input: unknown, signal?: AbortSignal) {
                return await new Promise<never>((_resolve, reject) => {
                    signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
                });
            },
            async listMessageEntries(_instance: string, _input: unknown, signal?: AbortSignal) {
                return await new Promise<never>((_resolve, reject) => {
                    signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
                });
            },
        };
        const vm = kind === "message"
            ? new MessageViewModel({ transport: transport as never })
            : new MessageHistoryViewModel({ transport: transport as never });
        try {
            const abort = new AbortController();
            const pending = vm.refreshInstance("alpha", abort.signal);
            abort.abort();
            await pending;
            assert.equal(vm.state.instances.alpha, undefined);
            assert.deepEqual(vm.state.failures, {});
        } finally { vm.close(); }
    });
}
