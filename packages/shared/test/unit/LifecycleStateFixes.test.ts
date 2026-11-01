import assert from "node:assert/strict";
import test from "node:test";

import { ArtifactViewModel } from "../../src/execution/artifact/ViewModel.ts";
import { ContextViewModel } from "../../src/workspace/context/ViewModel.ts";
import { MessageHistoryViewModel } from "../../src/workspace/message/ViewModel.ts";
import { Endpoint } from "../../src/transport/endpoint/Endpoint.ts";
import { createProcessTransport } from "../../src/execution/process/Transport.ts";
import { ProcessViewModel } from "../../src/execution/process/ViewModel.ts";
import { AuthViewModel } from "../../src/control/auth/ViewModel.ts";
import { OverviewViewModel } from "../../src/control/overview/ViewModel.ts";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const tick = async () => await new Promise<void>((resolve) => setImmediate(resolve));
const artifactSnapshot = (seq: number) => ({
    lastSeq: seq,
    shares: [{ shareId: `share-${seq}`, expiresAtMs: seq }],
    transfers: [{ transferId: `transfer-${seq}`, createdAt: `${seq}` }],
});
const processSnapshot = (seq: number, status: "running" | "stopped") => ({
    lastSeq: seq, snapshot: { name: "alpha", lastSeq: seq, status, ready: true, daemonState: "running", connectionState: "connected" },
});

test("Artifact fences reversed snapshot completions, including stale read errors, and accepts a later server reset", async () => {
    const old = deferred<unknown>();
    const failed = deferred<unknown>();
    let reads = 0;
    const vm = new ArtifactViewModel({ snapshot: async () => {
        switch (++reads) {
            case 1: return await old.promise;
            case 2: return artifactSnapshot(10);
            case 3: return await failed.promise;
            default: return artifactSnapshot(0);
        }
    } } as never);
    try {
        const pending = vm.refresh();
        await vm.refresh();
        old.resolve(artifactSnapshot(1));
        await pending;
        assert.equal(vm.state.lastSeq, 10);
        assert.equal(vm.state.shares[0]?.shareId, "share-10");
        assert.equal(vm.state.transfers[0]?.transferId, "transfer-10");
        const staleError = vm.refresh();
        await vm.refresh();
        failed.reject(new Error("obsolete read"));
        await staleError;
        assert.equal(vm.state.lastSeq, 0, "later authoritative read may reset the server cursor");
        assert.equal(vm.state.failure, undefined);
    } finally { vm.close(); }
});

for (const operation of ["revokeShare", "cancelTransfer", "createShare", "startTransfer"] as const) {
    test(`Artifact ${operation} completed after close cannot start a read or publish`, async () => {
        const response = deferred<never>();
        let reads = 0;
        const vm = new ArtifactViewModel({
            [operation]: async () => await response.promise,
            snapshot: async () => { reads++; return artifactSnapshot(7); },
        } as never);
        const pending = operation === "createShare" || operation === "startTransfer"
            ? vm[operation]("alpha", {} as never) : vm[operation]("id");
        // The RPC is resolved before close, but its await continuation still belongs to the old owner.
        response.resolve({} as never);
        vm.close();
        await pending;
        assert.equal(reads, 0);
        assert.equal(vm.state.lastSeq, 0);
    });
}

for (const operation of ["disable", "renew"] as const) {
    test(`Context ${operation} only refreshes within its original generation`, async () => {
        const response = deferred<never>();
        let reads = 0;
        const vm = new ContextViewModel({
            [operation]: async () => await response.promise,
            snapshot: async () => { reads++; return { revision: 8, contexts: [] }; },
        } as never);
        const pending = vm[operation]("ctx");
        response.resolve({} as never);
        vm.close();
        await pending;
        assert.equal(reads, 0);
        assert.equal(vm.state.revision, 0);
        await vm[operation]("ctx");
        assert.equal(reads, 1, "ordinary mutation completion still refreshes");
        assert.equal(vm.state.revision, 8);
        vm.close();
    });
}

for (const operation of ["start", "stop"] as const) {
    test(`Process ${operation} response cannot replace a newer read even when compensation would fail`, async () => {
        const response = deferred<unknown>();
        let reads = 0;
        const vm = new ProcessViewModel({
            start: async () => ({ snapshot: response.promise }),
            stop: async () => await response.promise,
            refresh: async () => {
                if (++reads === 1) return processSnapshot(10, "running");
                throw new Error("compensation unavailable");
            },
        } as never);
        try {
            const pending = vm[operation]();
            await vm.refresh();
            response.resolve(processSnapshot(5, "stopped").snapshot);
            await pending;
            await tick();
            assert.equal(vm.state.lastSeq, 10);
            assert.equal(vm.state.snapshot?.status, "running");
            assert.equal(reads, 1, "obsolete operations must not schedule a new read");
        } finally { vm.close(); }
    });
}

test("Process accepts an authoritative cursor reset after an operation", async () => {
    const vm = new ProcessViewModel({
        stop: async () => processSnapshot(10, "stopped").snapshot,
        refresh: async () => processSnapshot(0, "running"),
    } as never);
    try {
        await vm.stop();
        await tick();
        assert.equal(vm.state.lastSeq, 0);
        assert.equal(vm.state.snapshot?.status, "running");
    } finally { vm.close(); }
});

for (const kind of ["auth", "overview"] as const) {
    test(`${kind} polling ticks do not extend an awaitable refresh beyond its read`, async (t) => {
        t.mock.timers.enable({ apis: ["setInterval"] });
        const response = deferred<never>();
        let reads = 0;
        const read = async () => { reads++; return await response.promise; };
        const vm = kind === "auth"
            ? new AuthViewModel({ status: read } as never, { pollIntervalMs: 2 })
            : new OverviewViewModel({ get: read } as never, { refreshIntervalMs: 2 });
        try {
            vm.start();
            let finished = false;
            const pending = vm.refresh().then(() => { finished = true; });
            for (let i = 0; i < 5; i++) t.mock.timers.tick(2);
            assert.equal(reads, 1);
            response.resolve({ running: true, authMode: "none" } as never);
            await tick();
            assert.equal(finished, true, "successful read must settle without stopping polling");
            await pending;
            assert.equal(reads, 1);
            t.mock.timers.tick(2);
            await tick();
            assert.equal(reads, 2, "future ticks retain their own refresh work");
        } finally { vm.close(); }
    });
}

test("MessageHistory intentional Context cancellation clears loading; real failures and later reads remain visible", async () => {
    let reads = 0;
    const vm = new MessageHistoryViewModel({ transport: {
        async listMessageEntries(_instance: string, _query: unknown, signal?: AbortSignal) {
            if (++reads === 1) return await new Promise<never>((_resolve, reject) => {
                signal?.addEventListener("abort", () => reject(new Error("intentional cancellation")), { once: true });
            });
            if (reads === 2) throw new Error("backend unavailable");
            return { lastSeq: 0, entries: [] };
        },
    } as never });
    try {
        const controller = new AbortController();
        const pending = vm.loadContext("alpha", "ctx", controller.signal);
        assert.equal(vm.state.context?.loading, true);
        controller.abort();
        await pending;
        assert.equal(vm.state.context?.loading, false);
        assert.equal(vm.state.context?.failure, undefined);
        await vm.loadContext("alpha", "ctx");
        const failure: unknown = vm.state.context?.failure;
        assert.match(failure instanceof Error ? failure.message : "", /backend unavailable/);
        await vm.loadContext("alpha", "ctx");
        assert.equal(vm.state.context?.loading, false);
        assert.equal(vm.state.context?.failure, undefined);
    } finally { vm.close(); }
});


test("Artifact ordinary mutation completion still refreshes its authoritative projection", async () => {
    let reads = 0;
    const vm = new ArtifactViewModel({
        revokeShare: async () => ({}),
        snapshot: async () => { reads++; return artifactSnapshot(8); },
    } as never);
    try {
        await vm.revokeShare("share");
        assert.equal(reads, 1);
        assert.equal(vm.state.lastSeq, 8);
    } finally { vm.close(); }
});

for (const operation of ["start", "stop"] as const) {
    test(`Process transport ${operation} with an aborted operation cannot connect or send`, async () => {
        let connects = 0;
        const endpoint = new Endpoint({ connectChannel: async () => { connects++; throw new Error("must not connect"); } });
        const transport = createProcessTransport(endpoint, "alpha");
        const controller = new AbortController();
        const cancelled = new Error("operation already ended");
        controller.abort(cancelled);
        try {
            const pending = operation === "start" ? transport.start({ signal: controller.signal }) : transport.stop(controller.signal);
            await assert.rejects(pending, cancelled);
            assert.equal(connects, 0);
        } finally { endpoint.close(); }
    });
}
