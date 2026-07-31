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
    closeError?: Error;
    sendError?: Error;
    readonly #messages = new Set<(message: JsonValue) => void>();
    readonly #disconnects = new Set<(error: unknown) => void>();

    async send(message: JsonValue): Promise<void> {
        if (this.sendError !== undefined) {
            throw this.sendError;
        }
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
        if (this.closeError !== undefined) {
            throw this.closeError;
        }
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

    publish(message: JsonValue): void {
        for (const listener of this.#messages) listener(message);
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
    let signalConnectStarted!: () => void;
    const connectGate = new Promise<void>((resolve) => {
        releaseConnect = resolve;
    });
    const connectStarted = new Promise<void>((resolve) => {
        signalConnectStarted = resolve;
    });
    const connector: WorkerRpcConnector = {
        async connect() {
            signalConnectStarted();
            await connectGate;
            return channel;
        }
    };
    const bridge = new WorkerRpcBridge({
        connector,
        rpcOptions: { instanceName: "closing-connect" }
    });

    const connecting = bridge.connect();
    await connectStarted;
    bridge.close();

    await assert.rejects(withTimeout(connecting), /closed|reset|disconnected/u);
    assert.equal(channel.closed, false);
    releaseConnect();
    await waitUntil(() => channel.closed);
    assert.equal(channel.closed, true);
    assert.equal(bridge.connected, false);
});

test("reverse channel replacement takes over a stalled connector request", async () => {
    const stale = new MemoryChannel();
    let releaseConnect!: () => void;
    let signalConnectStarted!: () => void;
    const connectGate = new Promise<void>((resolve) => {
        releaseConnect = resolve;
    });
    const connectStarted = new Promise<void>((resolve) => {
        signalConnectStarted = resolve;
    });
    const connector: WorkerRpcConnector = {
        async connect() {
            signalConnectStarted();
            await connectGate;
            return stale;
        }
    };
    const bridge = new WorkerRpcBridge({
        connector,
        rpcOptions: { instanceName: "connecting-handoff" }
    });

    const request = bridge.request({
        id: "handoff-request",
        method: "worker.ping",
        params: {},
        type: "request"
    });
    await connectStarted;
    const replacement = new MemoryChannel();
    await bridge.replaceChannel(replacement);
    await waitUntil(() => replacement.sent.length === 1);
    replacement.respond("handoff-request", { pong: true });

    assert.deepEqual((await request).result, { pong: true });
    assert.equal(bridge.connected, true);
    releaseConnect();
    await waitUntil(() => stale.closed);
    assert.equal(bridge.connected, true);
});

test("WorkerRpcBridge rejects a pending request when the initial send fails", async () => {
    const connector = new DeferredConnector();
    const channel = new MemoryChannel();
    channel.sendError = new Error("send failed");
    connector.channel = channel;
    const bridge = new WorkerRpcBridge({
        connector,
        rpcOptions: { instanceName: "send-failure" }
    });

    const request = bridge.request({
        id: "request-send-failure",
        method: "worker.ping",
        params: {},
        type: "request"
    });

    await assert.rejects(withTimeout(request), /send failed|disconnected/iu);
    assert.equal(bridge.connected, false);
    assert.equal(channel.closed, true);
});

test("WorkerRpcBridge rejects duplicate pending request ids without losing the first request", async () => {
    const connector = new DeferredConnector();
    const channel = new MemoryChannel();
    connector.channel = channel;
    const bridge = new WorkerRpcBridge({
        connector,
        rpcOptions: { instanceName: "duplicate-request" }
    });
    const request = {
        id: "duplicate-id",
        method: "worker.ping",
        params: {},
        type: "request" as const
    };

    const first = bridge.request(request);
    await waitUntil(() => channel.sent.length === 1);
    await assert.rejects(bridge.request(request), /Duplicate Worker RPC request id/iu);
    channel.respond(request.id, { pong: true });

    assert.deepEqual((await first).result, { pong: true });
});

test("WorkerRpcBridge replays pending work even when the previous channel close throws", async () => {
    const connector = new DeferredConnector();
    const first = new MemoryChannel();
    connector.channel = first;
    const bridge = new WorkerRpcBridge({
        connector,
        preservePendingOnDisconnect: true,
        rpcOptions: { instanceName: "close-failure-replay" }
    });
    const pending = bridge.request({
        id: "replay-after-close-failure",
        method: "worker.ping",
        params: {},
        type: "request"
    });
    await waitUntil(() => first.sent.length === 1);
    first.closeError = new Error("close failed");
    const second = new MemoryChannel();
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (warning) => warnings.push(warning);
    try {
        await bridge.replaceChannel(second);
    } finally {
        console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
    assert.equal(second.sent.length, 1);
    second.respond("replay-after-close-failure", { pong: true });
    assert.deepEqual((await pending).result, { pong: true });
});

test("WorkerRpcBridge replays cancellation until the worker acknowledges it", async () => {
    const connector = new DeferredConnector();
    const first = new MemoryChannel();
    connector.channel = first;
    const bridge = new WorkerRpcBridge({
        connector,
        preservePendingOnDisconnect: true,
        rpcOptions: { instanceName: "cancel-replay" }
    });
    const controller = new AbortController();
    const pending = bridge.request({
        context: { ctxId: "ctx-cancel-replay" },
        id: "cancelled-call",
        method: "bash_run",
        params: {},
        type: "request"
    }, controller.signal);
    await waitUntil(() => first.sent.length === 1);

    controller.abort(new Error("user cancelled"));
    await assert.rejects(pending, /cancel/iu);
    await waitUntil(() => first.sent.length === 2);
    const cancellationId = first.sent[1]!.id;
    const second = new MemoryChannel();
    await bridge.replaceChannel(second);

    assert.equal(second.sent.length, 1);
    assert.equal(second.sent[0]?.id, cancellationId);
    second.respond(cancellationId, { cancelled: true });
    const third = new MemoryChannel();
    await bridge.replaceChannel(third);
    assert.equal(third.sent.length, 0);
});

test("WorkerRpcBridge expires an unacknowledged cancellation", async () => {
    const connector = new DeferredConnector();
    const first = new MemoryChannel();
    connector.channel = first;
    const bridge = new WorkerRpcBridge({
        cancellationRetentionMs: 10,
        connector,
        preservePendingOnDisconnect: true,
        rpcOptions: { instanceName: "cancel-expiry" }
    });
    const controller = new AbortController();
    const pending = bridge.request({
        context: { ctxId: "ctx-cancel-expiry" },
        id: "expired-cancelled-call",
        method: "bash_run",
        params: {},
        type: "request"
    }, controller.signal);
    await waitUntil(() => first.sent.length === 1);

    controller.abort(new Error("user cancelled"));
    await assert.rejects(pending, /cancel/iu);
    await waitUntil(() => first.sent.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = new MemoryChannel();
    await bridge.replaceChannel(second);

    assert.equal(second.sent.length, 0);
});

test("WorkerRpcBridge disconnects a replacement channel when replay fails", async () => {
    const connector = new DeferredConnector();
    const first = new MemoryChannel();
    connector.channel = first;
    const bridge = new WorkerRpcBridge({
        connector,
        preservePendingOnDisconnect: true,
        rpcOptions: { instanceName: "replay-failure" }
    });
    const pending = bridge.request({
        id: "replay-failure-request",
        method: "worker.ping",
        params: {},
        type: "request"
    });
    await waitUntil(() => first.sent.length === 1);
    first.disconnect();
    const failed = new MemoryChannel();
    failed.sendError = new Error("replay send failed");

    await assert.rejects(bridge.replaceChannel(failed), /replay send failed/iu);
    assert.equal(bridge.connected, false);
    assert.equal(failed.closed, true);

    const recovered = new MemoryChannel();
    await bridge.replaceChannel(recovered);
    assert.equal(recovered.sent.length, 1);
    recovered.respond("replay-failure-request", { pong: true });
    assert.deepEqual((await pending).result, { pong: true });
});

test("WorkerRpcBridge observes aborts that race with listener registration", async () => {
    const connector = new DeferredConnector();
    const channel = new MemoryChannel();
    connector.channel = channel;
    const bridge = new WorkerRpcBridge({
        connector,
        rpcOptions: { instanceName: "abort-race" }
    });
    const signal = new RegistrationRaceAbortSignal();

    const request = bridge.request({
        id: "request-abort-race",
        method: "bash_run",
        params: {},
        type: "request"
    }, signal as unknown as AbortSignal);

    await assert.rejects(withTimeout(request), /cancel/iu);
    assert.equal(channel.sent.length, 0);
});

test("WorkerRpcBridge isolates disconnect listener failures", async () => {
    const connector = new DeferredConnector();
    const channel = new MemoryChannel();
    connector.channel = channel;
    const bridge = new WorkerRpcBridge({
        connector,
        rpcOptions: { instanceName: "disconnect-listeners" }
    });
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (warning) => warnings.push(warning);
    try {
        let healthyListenerCalled = false;
        bridge.onDisconnect(() => {
            throw new Error("broken disconnect listener");
        });
        bridge.onDisconnect(() => {
            healthyListenerCalled = true;
        });
        await bridge.connect();

        channel.disconnect();

        assert.equal(healthyListenerCalled, true);
        assert.equal(warnings.length, 1);
    } finally {
        console.warn = originalWarn;
    }
});

test("WorkerRpcBridge rejects malformed success responses", async () => {
    const connector = new DeferredConnector();
    const channel = new MemoryChannel();
    connector.channel = channel;
    const bridge = new WorkerRpcBridge({
        connector,
        rpcOptions: { instanceName: "malformed-success" }
    });
    const pending = bridge.request({
        id: "malformed-success-response",
        method: "worker.ping",
        params: {},
        type: "request"
    });
    await waitUntil(() => channel.sent.length === 1);

    channel.publish({
        id: "malformed-success-response",
        ok: true,
        type: "response"
    });

    await assert.rejects(pending, /invalid response payload|disconnected/iu);
    assert.equal(bridge.connected, false);
});

test("WorkerRpcBridge rejects malformed failure responses", async () => {
    const connector = new DeferredConnector();
    const channel = new MemoryChannel();
    connector.channel = channel;
    const bridge = new WorkerRpcBridge({
        connector,
        rpcOptions: { instanceName: "malformed-failure" }
    });
    const pending = bridge.request({
        id: "malformed-failure-response",
        method: "worker.ping",
        params: {},
        type: "request"
    });
    await waitUntil(() => channel.sent.length === 1);

    channel.publish({
        error: { code: "worker.failed", message: "failed" },
        id: "malformed-failure-response",
        ok: false,
        type: "response"
    });

    await assert.rejects(pending, /invalid response payload|disconnected/iu);
    assert.equal(bridge.connected, false);
});

class RegistrationRaceAbortSignal {
    aborted = false;
    readonly reason = new Error("abort raced with registration");

    addEventListener(): void {
        this.aborted = true;
    }

    removeEventListener(): void {}
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("request did not settle")), 250);
            })
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("condition was not reached");
}
