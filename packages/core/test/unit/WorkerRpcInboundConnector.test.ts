import assert from "node:assert/strict";
import test from "node:test";

import { errorCodes, type Channel } from "@portable-devshell/shared";
import {
    encodeWorkerRpcMessage,
    WorkerRpcInboundConnector
} from "@portable-devshell/core/testing";

class MemoryChannel implements Channel {
    readonly closeListeners = new Set<(error?: Error) => void>();
    readonly frameListeners = new Set<(frame: Uint8Array) => void>();
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

    onFrame(listener: (frame: Uint8Array) => void): () => void {
        this.frameListeners.add(listener);
        return () => this.frameListeners.delete(listener);
    }

    async send(frame: Uint8Array): Promise<void> {
        this.sent.push(Uint8Array.from(frame));
    }

    emit(frame: Uint8Array): void {
        for (const listener of [...this.frameListeners]) listener(frame);
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

    await routed.send(request("control-1", "worker.ping"));
    await routed.send(request("bulk-1", "artifact.payload.read"));
    await routed.send(request("bulk-2", "artifact.receive.write"));

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

    await routed.send(request("bulk-replay", "artifact.payload.read"));
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
        assert.equal(readField(error, "code"), errorCodes.reverseTransportUnavailable);
        assert.equal(readField(error, "retryable"), true);
        return true;
    });
});

function request(id: string, method: string): Uint8Array {
    return encodeWorkerRpcMessage({
        id,
        method,
        params: {},
        type: "request"
    });
}

function readField(error: unknown, name: string): unknown {
    assert.equal(typeof error, "object");
    assert.notEqual(error, null);
    return (error as Record<string, unknown>)[name];
}
