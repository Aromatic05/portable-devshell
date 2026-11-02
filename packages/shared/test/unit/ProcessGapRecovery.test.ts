import assert from "node:assert/strict";
import test from "node:test";
import { ProcessViewModel } from "../../src/execution/process/ViewModel.ts";

const flush = async () => {
    for (let i = 0; i < 80; i++) await Promise.resolve();
};
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}
function setup(read: (count: number) => Promise<unknown>) {
    let next!: (event: unknown) => void;
    let reads = 0,
        snapshots = 0;
    const opens: number[] = [];
    const vm = new ProcessViewModel({
        async refresh() {
            const lastSeq = ++snapshots === 1 ? 1 : 50;
            return {
                lastSeq,
                snapshot: {
                    name: "alpha",
                    lastSeq,
                    status: "stopped",
                    ready: false,
                    daemonState: "stopped",
                    connectionState: "disconnected",
                },
            };
        },
        async readLogs() {
            return await read(++reads);
        },
        async subscribe(cursor: number) {
            opens.push(cursor);
            return {
                next: async () =>
                    await new Promise((resolve) => {
                        next = resolve;
                    }),
                close() {},
            };
        },
    } as never);
    return {
        vm,
        opens,
        reads: () => reads,
        gap: async () => {
            next({
                kind: "gap",
                gap: { fromSeq: 2, lastSeq: 50, nextSeq: 40 },
            });
            await flush();
        },
    };
}

test("Process gap reconciles materialized logs before resuming cursor without further log events", async () => {
    const reply = deferred<unknown>();
    const { vm, opens, gap, reads } = setup(async (count) =>
        count === 1 ? [{ message: "OLD" }] : await reply.promise,
    );
    try {
        await vm.load();
        await vm.readLogs();
        await flush();
        await gap();
        assert.equal(reads(), 2);
        assert.deepEqual(opens, [2]);
        assert.equal(vm.state.lastSeq, 1);
        reply.resolve([{ message: "GAP LOG" }]);
        await flush();
        assert.deepEqual(opens, [2, 51]);
        assert.equal(vm.state.lastSeq, 50);
        assert.equal(vm.state.connection, "live");
        assert.equal(vm.state.logs[0]?.message, "GAP LOG");
    } finally {
        vm.close();
    }
});

test("Process failed gap log read cannot advance cursor and retries the missing projection", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { vm, opens, gap } = setup(async (count) => {
        if (count === 2) throw new Error("log read failed");
        return [{ message: count === 1 ? "OLD" : "RECOVERED" }];
    });
    try {
        await vm.load();
        await vm.readLogs();
        await flush();
        await gap();
        assert.equal(vm.state.lastSeq, 1);
        assert.equal(vm.state.connection, "reconnecting");
        assert.deepEqual(opens, [2]);
        t.mock.timers.tick(500);
        await flush();
        assert.deepEqual(opens, [2, 2]);
        await gap();
        assert.deepEqual(opens, [2, 2, 51]);
        assert.equal(vm.state.logs[0]?.message, "RECOVERED");
    } finally {
        vm.close();
    }
});

for (const reset of ["close", "load"] as const) {
    test(`Process delayed gap logs cannot publish or resume after ${reset}`, async () => {
        const reply = deferred<unknown>();
        const { vm, opens, gap } = setup(async (count) =>
            count === 1 ? [{ message: "OLD" }] : await reply.promise,
        );
        try {
            await vm.load();
            await vm.readLogs();
            await flush();
            await gap();
            const resetModel = {
                close: () => vm.close(),
                load: () => vm.load(),
            };
            await resetModel[reset]();
            reply.resolve([{ message: "STALE" }]);
            await flush();
            assert.equal(
                vm.state.logs.some((log) => log.message === "STALE"),
                false,
            );
            assert.deepEqual(opens, [2]);
        } finally {
            vm.close();
        }
    });
}

test("Process gap fences an initial log read that was not yet materialized", async () => {
    const reply = deferred<unknown>();
    const { vm, opens, gap } = setup(async () => await reply.promise);
    try {
        await vm.load();
        const pending = vm.readLogs();
        await flush();
        await gap();
        assert.deepEqual(opens, [2, 51]);
        reply.resolve([{ message: "PRE GAP" }]);
        await pending;
        assert.equal(vm.state.logsLoaded, false);
        assert.deepEqual(vm.state.logs, []);
        assert.equal(vm.state.lastSeq, 50);
    } finally {
        vm.close();
    }
});
