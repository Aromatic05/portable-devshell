import assert from "node:assert/strict";
import test from "node:test";
import { ProcessViewModel } from "../../src/execution/process/ViewModel.ts";

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const snapshot = { lastSeq: 0, snapshot: { name: "alpha", lastSeq: 0, status: "stopped", ready: false,
    daemonState: "stopped", connectionState: "disconnected" } };

for (const { reset, apply, expected } of [
    { reset: "close", apply: async (vm: ProcessViewModel) => vm.close(), expected: [] },
    { reset: "load", apply: async (vm: ProcessViewModel) => await vm.load(), expected: [{ message: "NEW" }] },
]) {
    test(`log events coalesce reads, publish new logs, and fence in-flight results after ${reset}`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        let next!: (event: unknown) => void, finish!: (logs: unknown) => void;
        let reads = 0, snapshots = 0;
        const vm = new ProcessViewModel({
            async refresh() { snapshots++; return snapshot; },
            async readLogs() {
                reads++;
                if (reads === 3) return await new Promise((resolve) => { finish = resolve; });
                return [{ message: reads === 1 ? "OLD" : "NEW" }];
            },
            async subscribe() { return { next: async () => await new Promise((resolve) => { next = resolve; }), close() {} }; },
        } as never);
        let seq = 0;
        const event = async () => {
            next({ kind: "event", event: { seq: ++seq, at: "", instanceName: "alpha", type: "log.appended" } });
            await flush();
        };
        try {
            await vm.load();
            await vm.readLogs();
            await flush();
            for (let i = 0; i < 20; i++) await event();
            assert.equal(reads, 1);
            t.mock.timers.tick(100);
            await flush();
            assert.equal(reads, 2);
            assert.equal(vm.state.logs[0]?.message, "NEW");
            assert.equal(snapshots, 1);
            await event();
            t.mock.timers.tick(100);
            await flush();
            assert.equal(reads, 3);
            for (let i = 0; i < 20; i++) await event();
            t.mock.timers.tick(1000);
            assert.equal(reads, 3, "only one event read may be in flight");
            await apply(vm);
            finish([{ message: "STALE" }]);
            await flush();
            assert.notEqual(vm.state.logs[0]?.message, "STALE");
            t.mock.timers.tick(1000);
            await flush();
            assert.equal(reads, 3);
            assert.deepEqual(vm.state.logs, expected);
        } finally { vm.close(); }
    });
}

test("close cancels the pending log timer before it sends an RPC", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let next!: (event: unknown) => void, reads = 0;
    const vm = new ProcessViewModel({
        async refresh() { return snapshot; },
        async readLogs() { reads++; return []; },
        async subscribe() { return { next: async () => await new Promise((resolve) => { next = resolve; }), close() {} }; },
    } as never);
    await vm.load();
    await vm.readLogs();
    await flush();
    next({ kind: "event", event: { seq: 1, at: "", instanceName: "alpha", type: "log.appended" } });
    await flush();
    vm.close();
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(reads, 1);
});

test("events arriving during a slow log read request only one coalesced follow-up", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let next!: (event: unknown) => void, finish!: (logs: unknown) => void;
    let reads = 0, seq = 0;
    const vm = new ProcessViewModel({
        async refresh() { return snapshot; },
        async readLogs() {
            reads++;
            if (reads === 2) return await new Promise((resolve) => { finish = resolve; });
            return [{ message: reads === 1 ? "OLD" : "LATEST" }];
        },
        async subscribe() { return { next: async () => await new Promise((resolve) => { next = resolve; }), close() {} }; },
    } as never);
    const event = async () => {
        next({ kind: "event", event: { seq: ++seq, at: "", instanceName: "alpha", type: "log.appended" } });
        await flush();
    };
    try {
        await vm.load();
        await vm.readLogs();
        await flush();
        await event();
        t.mock.timers.tick(100);
        await flush();
        for (let i = 0; i < 30; i++) await event();
        t.mock.timers.tick(1000);
        assert.equal(reads, 2);
        finish([{ message: "INTERMEDIATE" }]);
        await flush();
        t.mock.timers.tick(100);
        await flush();
        assert.equal(reads, 3);
        assert.equal(vm.state.logs[0]?.message, "LATEST");
        t.mock.timers.tick(1000);
        await flush();
        assert.equal(reads, 3);
    } finally { vm.close(); }
});
