import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue } from "@portable-devshell/shared";
import {
    WorkerRpcBridge,
    WorkerRpcClient,
    type WorkerRpcChannel,
    type WorkerRpcConnector,
    type WorkerRpcRequestEnvelope
} from "@portable-devshell/core/testing";

class DeferredConnector implements WorkerRpcConnector {
    channel?: MemoryChannel;

    async connect(): Promise<WorkerRpcChannel> {
        if (this.channel === undefined) {
            throw new Error("reverse channel is offline");
        }
        return this.channel;
    }
}

class MemoryChannel implements WorkerRpcChannel {
    readonly sent: WorkerRpcRequestEnvelope[] = [];
    closed = false;
    readonly #messages = new Set<(message: JsonValue) => void>();
    readonly #disconnects = new Set<(error: unknown) => void>();

    async send(message: JsonValue): Promise<void> {
        this.sent.push(message as unknown as WorkerRpcRequestEnvelope);
    }

    onMessage(listener: (message: JsonValue) => void): () => void {
        this.#messages.add(listener);
        return () => this.#messages.delete(listener);
    }

    onDisconnect(listener: (error: unknown) => void): () => void {
        this.#disconnects.add(listener);
        return () => this.#disconnects.delete(listener);
    }

    close(): void {
        this.closed = true;
    }

    disconnect(): void {
        for (const listener of this.#disconnects) {
            listener(new Error("network lost"));
        }
    }

    respond(id: string, result: JsonValue): void {
        for (const listener of this.#messages) {
            listener({ type: "response", id, ok: true, result });
        }
    }
}

test("reverse RPC bridge replays pending request with the original request id after channel replacement", async () => {
    const connector = new DeferredConnector();
    const first = new MemoryChannel();
    connector.channel = first;
    const bridge = new WorkerRpcBridge({
        connector,
        preservePendingOnDisconnect: true,
        rpcOptions: { instanceName: "reverse-test" }
    });
    const client = new WorkerRpcClient(bridge);

    const pending = client.request("bash_run", { command: "printf replay" });
    await waitUntil(() => first.sent.length === 1);
    const requestId = first.sent[0]?.id;
    assert.equal(requestId, "1");

    first.disconnect();
    const second = new MemoryChannel();
    await bridge.replaceChannel(second);

    assert.equal(second.sent.length, 1);
    assert.equal(second.sent[0]?.id, requestId);
    second.respond(requestId!, { stdout: "replay" });
    assert.deepEqual(await pending, { stdout: "replay" });
});

test("closing an RPC bridge while connecting cannot resurrect the channel", async () => {
    const channel = new MemoryChannel();
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => {
        releaseConnect = resolve;
    });
    const connector: WorkerRpcConnector = {
        async connect() {
            await connectGate;
            return channel;
        }
    };
    const bridge = new WorkerRpcBridge({
        connector,
        rpcOptions: { instanceName: "closing-connect" }
    });

    const connecting = bridge.connect();
    bridge.close();
    releaseConnect();

    await assert.rejects(connecting, /closed|reset/u);
    assert.equal(channel.closed, true);
    assert.equal(bridge.connected, false);
});

async function waitUntil(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("condition was not reached");
}
