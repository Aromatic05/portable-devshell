import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
    errorCodes,
    StreamChannel,
    type Channel,
} from "@portable-devshell/shared";
import {
    FrameProtocol,
    type FrameStream,
} from "@portable-devshell/shared/transport/frame";
import {
    decodeWorkerRpcMessage,
    encodeWorkerRpcMessage,
    WorkerRpcInboundConnector,
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

test("inbound connector opens one worker.rpc Frame stream on the physical reverse channel", async () => {
    const connector = new WorkerRpcInboundConnector();
    const peer = createFramePeer();

    assert.equal(connector.connected, false);
    connector.attach(peer.controller);
    const [routed, workerRpc] = await Promise.all([
        connector.connect(),
        peer.workerRpc,
    ]);
    assert.equal(connector.connected, true);
    assert.notEqual(routed, peer.controller);

    const bytes = Uint8Array.from([0, 1, 2, 3, 4]);
    await routed.write(bytes);
    assert.deepEqual(await workerRpc.read(), bytes);

    connector.detach(peer.controller);
    assert.equal(connector.connected, false);
});

test("physical reverse replacement creates a new worker.rpc stream and closes the previous generation", async () => {
    const connector = new WorkerRpcInboundConnector();
    const first = createFramePeer();
    const second = createFramePeer();

    connector.attach(first.controller);
    const [previous] = await Promise.all([
        connector.connect(),
        first.workerRpc,
    ]);
    connector.attach(second.controller);
    const [current] = await Promise.all([
        connector.connect(),
        second.workerRpc,
    ]);

    assert.notEqual(current, previous);
    assert.equal(previous.closed, true);
    assert.equal(first.controller.closed, true);

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

function createFramePeer(): {
    controller: Channel;
    workerRpc: Promise<FrameStream>;
} {
    const controllerToWorker = new PassThrough();
    const workerToController = new PassThrough();
    const pair: {
        controller?: StreamChannel;
        worker?: StreamChannel;
        closed: boolean;
    } = { closed: false };
    const closePair = (error?: Error) => {
        if (pair.closed) return;
        pair.closed = true;
        pair.controller?.close(error);
        pair.worker?.close(error);
    };
    const controller = new StreamChannel(workerToController, controllerToWorker, {
        closeTransport: closePair,
    });
    const worker = new StreamChannel(controllerToWorker, workerToController, {
        closeTransport: closePair,
    });
    pair.controller = controller;
    pair.worker = worker;
    const protocol = new FrameProtocol(worker, { role: "acceptor" });
    const workerRpc = (async () => {
        const open = await protocol.nextOpen();
        assert.notEqual(open, undefined);
        assert.equal(open!.service, "worker.rpc");
        assert.equal(open!.metadata.byteLength, 0);
        return await open!.accept();
    })();
    return { controller, workerRpc };
}

function readField(error: unknown, name: string): unknown {
    assert.equal(typeof error, "object");
    assert.notEqual(error, null);
    return (error as Record<string, unknown>)[name];
}

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
