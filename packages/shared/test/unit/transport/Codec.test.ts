import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { rm } from "node:fs/promises";
import test from "node:test";

import {
    asInstanceName,
    Channel,
    Codec,
    type Event,
    type FrameChannel
} from "@portable-devshell/shared";
import { createTestIpcPath } from "../../../../../test/TestPlatformSupport.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

interface CodecPair {
    client: Codec;
    clientChannel: Channel;
    directory: string;
    listener: Server;
    server: Codec;
}

async function pair(clientPeer: "tui" | "web" = "tui"): Promise<CodecPair> {
    const directory = await createTestTempDirectory("codec");
    const socketPath = createTestIpcPath("codec", directory);
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(socketPath, resolve);
    });
    const accepted = new Promise<Channel>((resolve) => listener.once("connection", (socket) => resolve(Channel.accept(socket))));
    const clientChannel = await Channel.connect(socketPath);
    const serverChannel = await accepted;
    return {
        client: new Codec(clientChannel, { local: clientPeer, remote: "server" }),
        clientChannel,
        directory,
        listener,
        server: new Codec(serverChannel, { local: "server" })
    };
}

async function closePair(value: CodecPair): Promise<void> {
    value.client.close();
    value.server.close();
    await new Promise<void>((resolve) => value.listener.close(() => resolve()));
    await rm(value.directory, { force: true, recursive: true });
}

function onceEvent(codec: Codec): Promise<Event> {
    return new Promise((resolve) => {
        const remove = codec.onEvent((event) => {
            remove();
            resolve(event);
        });
    });
}

class FailingFrameChannel implements FrameChannel {
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #frameListeners = new Set<(frame: Uint8Array) => void>();
    closed = false;
    closeError?: Error;
    sendError?: Error;

    async send(): Promise<void> {
        if (this.sendError !== undefined) throw this.sendError;
    }

    onFrame(listener: (frame: Uint8Array) => void): () => void {
        this.#frameListeners.add(listener);
        return () => this.#frameListeners.delete(listener);
    }

    onClose(listener: (error?: Error) => void): () => void {
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    close(error?: Error): void {
        if (this.closeError !== undefined) throw this.closeError;
        this.closed = true;
        for (const listener of [...this.#closeListeners]) listener(error);
    }
}

test("Codec round-trips Event and binds the first server peer", async (t) => {
    const value = await pair();
    t.after(() => closePair(value));
    const incoming = onceEvent(value.server);
    await value.client.send({
        id: "tui-1",
        destination: asInstanceName("aromatic-pc"),
        name: "todo.get",
        payload: {}
    });

    assert.deepEqual(await incoming, {
        id: "tui-1",
        from: "tui",
        to: "server",
        destination: "aromatic-pc",
        name: "todo.get",
        payload: {}
    });
    assert.equal(value.server.remotePeer, "tui");
});

test("Codec accepts web as a server-bound client peer", async (t) => {
    const value = await pair("web");
    t.after(() => closePair(value));

    const incoming = onceEvent(value.server);
    await value.client.send({ id: "web-1", destination: "@control", name: "service.ping" });

    assert.equal((await incoming).from, "web");
    assert.equal(value.server.remotePeer, "web");
});

test("Codec preserves replyTo, streamId, error, and seq", async (t) => {
    const value = await pair();
    t.after(() => closePair(value));
    const binding = onceEvent(value.server);
    await value.client.send({ id: "bind-1", destination: "@control", name: "service.ping" });
    await binding;

    const incoming = onceEvent(value.client);
    await value.server.send({
        id: "server-1",
        replyTo: "bind-1",
        streamId: "stream-1",
        destination: "@control",
        name: "service.ping",
        seq: 3,
        error: { code: "test.failed", message: "failed", retryable: false }
    });

    const event = await incoming;
    assert.equal(event.replyTo, "bind-1");
    assert.equal(event.streamId, "stream-1");
    assert.equal(event.seq, 3);
    assert.equal(event.error?.code, "test.failed");
});

test("Codec rejects invalid operation names before sending", async (t) => {
    const value = await pair();
    t.after(() => closePair(value));

    await assert.rejects(
        value.client.send({
            id: "bad",
            destination: "@control",
            name: "three.segment.name" as "service.ping"
        }),
        /module\.operation/
    );
});

test("Codec rejects legacy envelopes", async (t) => {
    const value = await pair();
    t.after(() => closePair(value));
    const closed = new Promise<Error | undefined>((resolve) => value.server.onClose(resolve));

    await value.clientChannel.send(Buffer.from(JSON.stringify({
        id: "old",
        method: "control.ping",
        target: { kind: "control" },
        type: "request"
    }), "utf8"));

    assert.equal((await closed as { code?: string } | undefined)?.code, "protocol.invalidDirection");
});

test("Codec rejects a peer change after first-event binding", async (t) => {
    const value = await pair();
    t.after(() => closePair(value));
    const binding = onceEvent(value.server);
    await value.client.send({ id: "bind", destination: "@control", name: "service.ping" });
    await binding;
    const closed = new Promise<Error | undefined>((resolve) => value.server.onClose(resolve));

    await value.clientChannel.send(Buffer.from(JSON.stringify({
        id: "spoof",
        from: "cli",
        to: "server",
        destination: "@control",
        name: "service.ping"
    }), "utf8"));

    assert.equal((await closed as { code?: string } | undefined)?.code, "protocol.invalidDirection");
});

test("Codec send failure closes the protocol and notifies listeners", async () => {
    const channel = new FailingFrameChannel();
    channel.sendError = new Error("frame send failed");
    const codec = new Codec(channel, { local: "tui", remote: "server" });
    const closed = new Promise<Error | undefined>((resolve) => codec.onClose(resolve));

    await assert.rejects(
        codec.send({ id: "failed-send", destination: "@control", name: "service.ping" }),
        /frame send failed/iu
    );

    assert.equal(codec.closed, true);
    assert.equal(channel.closed, true);
    assert.equal((await closed)?.message, "frame send failed");
});

test("Codec closes locally when the transport close operation throws", async () => {
    const channel = new FailingFrameChannel();
    channel.closeError = new Error("transport close failed");
    const codec = new Codec(channel, { local: "tui", remote: "server" });
    const closed = new Promise<Error | undefined>((resolve) => codec.onClose(resolve));

    codec.close();

    assert.equal(codec.closed, true);
    assert.equal((await closed)?.message, "transport close failed");
});

test("Codec isolates late close listener failures", async () => {
    const channel = new FailingFrameChannel();
    const codec = new Codec(channel, { local: "tui", remote: "server" });
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (warning) => warnings.push(warning);
    try {
        codec.close();
        let notified = 0;
        codec.onClose(() => {
            throw new Error("late codec close listener failed");
        });
        codec.onClose(() => {
            notified += 1;
        });
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(notified, 1);
        assert.equal(warnings.length, 1);
    } finally {
        console.warn = originalWarn;
    }
});
