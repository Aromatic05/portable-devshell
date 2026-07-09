import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { asInstanceName, type JsonValue } from "@portable-devshell/shared";
import type { WorkerInstance } from "@portable-devshell/core";

import { ControlRpcServer } from "../../../control/dist/control/rpc/ControlRpcServer.js";
import { InstanceRegistry } from "../../../control/dist/instance/registry/InstanceRegistry.js";
import { TuiControlClient, TuiControlSession } from "../../dist/index.js";

test("TuiControlSession pulls instances, snapshots, subscribes, and recovers from stream.gap", async (t) => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-tui-session-"));
    const socketPath = join(runtimeDir, "control.sock");
    const worker = new FakeWorker("alpha");
    const server = createServer(socketPath, worker, () => 7);
    const session = new TuiControlSession({
        client: new TuiControlClient({ socketPath })
    });

    worker.emit("toolCall.completed", {
        callId: "seed-1",
        source: "tui",
        toolName: "bash_run"
    });
    worker.emit("toolCall.completed", {
        callId: "seed-2",
        source: "tui",
        toolName: "bash_run"
    });

    await server.start();

    t.after(async () => {
        await session.stop();
        await server.stop().catch(() => undefined);
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await session.start();
    await waitFor(() => session.store.getState().connection.status === "connected");
    await waitFor(() => worker.subscribeFromSeqs.length === 1);

    assert.equal(session.store.getState().instances.length, 1);
    assert.equal(session.store.getState().snapshotsByInstance.alpha?.lastSeq, 2);
    assert.equal(session.store.getState().configView?.version, 7);
    assert.equal(worker.snapshotCallCount >= 2, true);
    assert.deepEqual(worker.subscribeFromSeqs, [2]);

    worker.emit("toolCall.completed", {
        callId: "live-3",
        source: "tui",
        toolName: "bash_run"
    });
    await waitFor(() => session.store.getState().rawEvents.some((event) => event.seq === 3));

    worker.emit("toolCall.completed", {
        callId: "live-4",
        source: "tui",
        toolName: "bash_run"
    });
    worker.emit("toolCall.completed", {
        callId: "live-5",
        source: "tui",
        toolName: "bash_run"
    });
    worker.dropBefore(5);

    await waitFor(() => worker.subscribeFromSeqs.includes(5));
    assert.equal(worker.snapshotCallCount >= 3, true);

    worker.emit("toolCall.completed", {
        callId: "after-gap",
        source: "tui",
        toolName: "bash_run"
    });
    await waitFor(() => session.store.getState().rawEvents.some((event) => event.seq === 6));

    await server.stop();
    await waitFor(() => session.store.getState().connection.status === "disconnected");
});

test("TuiControlSession reports missing control without auto-starting it", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-tui-not-running-"));
    const socketPath = join(runtimeDir, "control.sock");
    const session = new TuiControlSession({
        client: new TuiControlClient({ socketPath })
    });

    try {
        await session.start();
        assert.equal(session.store.getState().connection.status, "disconnected");
        assert.equal(session.store.getState().connection.errorCode, "control.notRunning");
        assert.equal(session.store.getState().connection.errorMessage, "control server is not running.");
        assert.deepEqual(session.store.getState().instances, []);
    } finally {
        await session.stop();
        await rm(runtimeDir, { force: true, recursive: true });
    }
});

function createServer(socketPath: string, worker: FakeWorker, getConfigVersion: () => number): ControlRpcServer {
    return new ControlRpcServer({
        configEditorService: {
            getConfigView() {
                return { instances: [{ name: "alpha" }], version: getConfigVersion() };
            }
        } as never,
        instanceRegistry: new InstanceRegistry([
            {
                allowTools: [],
                enabled: true,
                mcpEnabled: false,
                mcpPath: "",
                name: "alpha",
                worker: worker as unknown as WorkerInstance
            }
        ]),
        socketPath
    });
}

class FakeWorker {
    readonly #name: string;
    #events: Array<{ at: string; data?: unknown; instanceName: string; seq: number; type: string }> = [];
    #lastSeq = 0;
    snapshotCallCount = 0;
    subscribeFromSeqs: number[] = [];

    constructor(name: string) {
        this.#name = name;
    }

    snapshot() {
        this.snapshotCallCount += 1;
        return {
            connectionState: "connected",
            daemonState: "running",
            lastSeq: this.#lastSeq,
            name: asInstanceName(this.#name),
            ready: true,
            status: "ready"
        } as const;
    }

    subscribe(fromSeq = 1) {
        this.subscribeFromSeqs.push(fromSeq);

        const nextSeq = this.#events[0]?.seq ?? this.#lastSeq + 1;

        if (fromSeq < nextSeq) {
            return {
                code: "stream.gap",
                fromSeq,
                kind: "gap" as const,
                lastSeq: this.#lastSeq,
                nextSeq
            };
        }

        return {
            events: this.#events.filter((event) => event.seq >= fromSeq),
            kind: "events" as const,
            lastSeq: this.#lastSeq
        };
    }

    emit(type: string, data?: Record<string, JsonValue>): void {
        const event = {
            at: new Date().toISOString(),
            data,
            instanceName: this.#name,
            seq: this.#lastSeq + 1,
            type
        };

        this.#lastSeq = event.seq;
        this.#events.push(event);
    }

    dropBefore(seq: number): void {
        this.#events = this.#events.filter((event) => event.seq >= seq);
    }
}

async function waitFor(factory: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (factory()) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error("Timed out waiting for condition.");
}
