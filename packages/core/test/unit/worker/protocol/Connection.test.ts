import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { errorCodes, type Channel } from "@portable-devshell/shared";
import { encodeFrame } from "@portable-devshell/shared/transport/frame";
import {
    decodeWorkerRpcMessage,
    encodeWorkerRpcMessage,
    WorkerRpcInboundConnector,
    WorkerRpcProcessConnector,
} from "@portable-devshell/core/testing";

class MemoryChannel implements Channel {
    readonly closeListeners = new Set<(error?: Error) => void>();
    readonly dataListeners = new Set<(data: Uint8Array) => void>();
    readonly sent: Uint8Array[] = [];
    closed = false;

    close(error?: Error): void {
        if (this.closed) return;
        this.closed = true;
        for (const listener of [...this.closeListeners]) listener(error);
    }

    onClose(listener: (error?: Error) => void): () => void {
        this.closeListeners.add(listener);
        return () => this.closeListeners.delete(listener);
    }

    onData(listener: (data: Uint8Array) => void): () => void {
        this.dataListeners.add(listener);
        return () => this.dataListeners.delete(listener);
    }

    async write(data: Uint8Array): Promise<void> {
        this.sent.push(Uint8Array.from(data));
    }

    emit(data: Uint8Array): void {
        for (const listener of [...this.dataListeners]) listener(data);
    }
}

test("inbound connector keeps the active control generation until its channel detaches", async () => {
    const connector = new WorkerRpcInboundConnector();
    const first = new MemoryChannel();
    const unrelated = new MemoryChannel();

    assert.equal(connector.connected, false);
    connector.attach(first, "control");
    assert.equal(connector.connected, true);
    const routed = await connector.connect();
    assert.notEqual(routed, first);

    connector.detach(unrelated);
    assert.equal(connector.connected, true);
    assert.equal(await connector.connect(), routed);

    connector.detach(first);
    assert.equal(connector.connected, false);
});

test("inbound connector routes artifact payload traffic to bulk without blocking control", async () => {
    const connector = new WorkerRpcInboundConnector();
    const control = new MemoryChannel();
    const bulk = new MemoryChannel();
    connector.attach(control, "control");
    connector.attach(bulk, "bulk");
    const routed = await connector.connect();

    await routed.write(request("control-1", "worker.ping"));
    await routed.write(request("bulk-1", "artifact.payload.read"));
    await routed.write(request("bulk-2", "artifact.receive.write"));

    assert.equal(control.sent.length, 1);
    assert.equal(bulk.sent.length, 2);
});

test("bulk lane loss replays pending bulk requests on control while keeping the connector online", async () => {
    const connector = new WorkerRpcInboundConnector();
    const control = new MemoryChannel();
    const bulk = new MemoryChannel();
    connector.attach(control, "control");
    connector.attach(bulk, "bulk");
    const routed = await connector.connect();

    await routed.write(request("bulk-replay", "artifact.payload.read"));
    assert.equal(bulk.sent.length, 1);
    bulk.close(new Error("bulk disconnected"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(connector.connected, true);
    assert.equal(control.sent.length, 1);
    assert.deepEqual(control.sent[0], bulk.sent[0]);
});

test("control replacement creates a new routed generation and closes the previous generation", async () => {
    const connector = new WorkerRpcInboundConnector();
    const first = new MemoryChannel();
    const second = new MemoryChannel();

    connector.attach(first, "control");
    const previous = await connector.connect();
    connector.attach(second, "control");
    const current = await connector.connect();

    assert.notEqual(current, previous);
    assert.equal(previous.closed, true);
    assert.equal(first.closed, true);

    connector.detach();
    assert.equal(connector.connected, false);
});

test("offline inbound connector returns a typed retryable reverse transport error", async () => {
    const connector = new WorkerRpcInboundConnector();

    await assert.rejects(connector.connect(), (error: unknown) => {
        assert.equal(
            readField(error, "code"),
            errorCodes.reverseTransportUnavailable,
        );
        assert.equal(readField(error, "retryable"), true);
        return true;
    });
});

function request(id: string, method: string): Uint8Array {
    return encodeFrame(
        encodeWorkerRpcMessage({
            id,
            method,
            params: {},
            type: "request",
        }),
    );
}

function readField(error: unknown, name: string): unknown {
    assert.equal(typeof error, "object");
    assert.notEqual(error, null);
    return (error as Record<string, unknown>)[name];
}

test("WorkerRpcProcessConnector aborts immediately and kills a late process", async () => {
    let releaseSpawn!: () => void;
    let signalSpawnStarted!: () => void;
    let killCount = 0;
    const spawnGate = new Promise<void>((resolve) => {
        releaseSpawn = resolve;
    });
    const spawnStarted = new Promise<void>((resolve) => {
        signalSpawnStarted = resolve;
    });
    const process = {
        exit: new Promise(() => undefined),
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill() {
            killCount += 1;
            return true;
        },
    };
    const connector = new WorkerRpcProcessConnector(
        {
            async spawnWorkerRpc() {
                signalSpawnStarted();
                await spawnGate;
                return process;
            },
        } as never,
        { instanceName: "late-process" },
    );
    const controller = new AbortController();
    const reason = new Error("spawn cancelled");
    const connecting = connector.connect(controller.signal);
    await spawnStarted;

    controller.abort(reason);

    await assert.rejects(withTimeout(connecting), reason);
    assert.equal(killCount, 0);
    releaseSpawn();
    await waitUntil(() => killCount === 1);
});

test("Worker RPC codec rejects invalid UTF-8", () => {
    const payload = Buffer.concat([
        Buffer.from('{"value":"', "utf8"),
        Buffer.from([0xff]),
        Buffer.from('"}', "utf8"),
    ]);
    assert.throws(
        () => decodeWorkerRpcMessage(payload),
        (error: unknown) =>
            (error as { code?: string }).code === "protocol.invalidJson",
    );
});

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error("operation did not settle")),
                    250,
                );
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline)
            throw new Error("Timed out waiting for condition.");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
