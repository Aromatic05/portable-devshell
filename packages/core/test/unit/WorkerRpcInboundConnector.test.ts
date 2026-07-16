import assert from "node:assert/strict";
import test from "node:test";

import { errorCodes, type JsonValue } from "@portable-devshell/shared";
import {
    WorkerRpcInboundConnector,
    type WorkerRpcChannel
} from "@portable-devshell/core/testing";

class MemoryChannel implements WorkerRpcChannel {
    closed = false;

    close(): void {
        this.closed = true;
    }

    onDisconnect(): () => void {
        return () => undefined;
    }

    onMessage(): () => void {
        return () => undefined;
    }

    async send(_message: JsonValue): Promise<void> {}
}

test("inbound connector keeps the attached reverse channel until the matching channel detaches", async () => {
    const connector = new WorkerRpcInboundConnector();
    const first = new MemoryChannel();
    const unrelated = new MemoryChannel();

    assert.equal(connector.connected, false);
    connector.attach(first);
    assert.equal(connector.connected, true);
    assert.equal(await connector.connect(), first);

    connector.detach(unrelated);
    assert.equal(connector.connected, true);
    assert.equal(await connector.connect(), first);

    connector.detach(first);
    assert.equal(connector.connected, false);
});

test("inbound connector replacement and unconditional detach use the latest channel", async () => {
    const connector = new WorkerRpcInboundConnector();
    const first = new MemoryChannel();
    const second = new MemoryChannel();

    connector.attach(first);
    connector.attach(second);
    assert.equal(await connector.connect(), second);

    connector.detach();
    assert.equal(connector.connected, false);
});

test("offline inbound connector returns a typed retryable reverse transport error", async () => {
    const connector = new WorkerRpcInboundConnector();

    await assert.rejects(connector.connect(), (error: unknown) => {
        assert.equal(readField(error, "code"), errorCodes.reverseTransportUnavailable);
        assert.equal(readField(error, "retryable"), true);
        assert.match(String(readField(error, "message")), /Reverse worker is offline/u);
        return true;
    });
});

function readField(error: unknown, name: string): unknown {
    assert.equal(typeof error, "object");
    assert.notEqual(error, null);
    return (error as Record<string, unknown>)[name];
}
