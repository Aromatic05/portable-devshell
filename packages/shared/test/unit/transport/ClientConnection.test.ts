import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    Channel,
    ClientConnection,
    Codec,
    createError,
    type Event,
    type JsonValue
} from "@portable-devshell/shared";

interface ReceivedEvent {
    codec: Codec;
    event: Event;
}

class ControlPeer {
    readonly #events: ReceivedEvent[] = [];
    readonly #waiters: Array<(value: ReceivedEvent) => void> = [];
    readonly #sockets = new Set<Socket>();
    readonly directory: string;
    readonly listener: Server;
    readonly socketPath: string;
    connectionCount = 0;

    private constructor(directory: string, listener: Server, socketPath: string) {
        this.directory = directory;
        this.listener = listener;
        this.socketPath = socketPath;
    }

    static async create(): Promise<ControlPeer> {
        const directory = await mkdtemp(join(tmpdir(), "portable-devshell-client-connection-"));
        const socketPath = join(directory, "control.sock");
        const listener = createServer();
        const peer = new ControlPeer(directory, listener, socketPath);
        listener.on("connection", (socket) => peer.#accept(socket));
        await new Promise<void>((resolve, reject) => {
            listener.once("error", reject);
            listener.listen(socketPath, resolve);
        });
        return peer;
    }

    async nextEvent(): Promise<ReceivedEvent> {
        return this.#events.shift() ?? await new Promise((resolve) => this.#waiters.push(resolve));
    }

    async reply(received: ReceivedEvent, payload?: JsonValue): Promise<void> {
        await received.codec.send({
            id: `reply-${received.event.id}`,
            replyTo: received.event.id,
            destination: received.event.destination,
            name: received.event.name,
            ...(payload === undefined ? {} : { payload })
        });
    }

    async openStream(received: ReceivedEvent, streamId: string, payload?: JsonValue): Promise<void> {
        await received.codec.send({
            id: `reply-${received.event.id}`,
            replyTo: received.event.id,
            streamId,
            destination: received.event.destination,
            name: received.event.name,
            ...(payload === undefined ? {} : { payload })
        });
    }

    async sendStream(
        received: ReceivedEvent,
        streamId: string,
        name: `${string}.${string}`,
        payload?: JsonValue
    ): Promise<void> {
        await received.codec.send({
            id: `event-${streamId}-${name}`,
            streamId,
            destination: received.event.destination,
            name,
            ...(payload === undefined ? {} : { payload })
        });
    }

    disconnectAll(): void {
        for (const socket of this.#sockets) {
            socket.destroy();
        }
    }

    async close(): Promise<void> {
        this.disconnectAll();
        await new Promise<void>((resolve) => this.listener.close(() => resolve()));
        await rm(this.directory, { force: true, recursive: true });
    }

    #accept(socket: Socket): void {
        this.connectionCount += 1;
        this.#sockets.add(socket);
        socket.once("close", () => this.#sockets.delete(socket));
        const codec = new Codec(Channel.accept(socket), { local: "server" });
        codec.onEvent((event) => {
            const received = { codec, event };
            const waiter = this.#waiters.shift();
            if (waiter === undefined) {
                this.#events.push(received);
            } else {
                waiter(received);
            }
        });
    }
}

function client(socketPath: string, mode: "short" | "persistent" = "persistent"): ClientConnection {
    return new ClientConnection({
        mapError: (error) => error instanceof Error ? error : new Error(String(error)),
        mapRemoteError: (error) => createError(error),
        mode,
        peer: "tui",
        socketPath
    });
}

test("persistent ClientConnection reuses one socket and resolves concurrent replies out of order", async (t) => {
    const peer = await ControlPeer.create();
    const connection = client(peer.socketPath);
    t.after(async () => {
        connection.close();
        await peer.close();
    });

    const firstPromise = connection.requestEvent("@control", "service", "first");
    const secondPromise = connection.requestEvent("@control", "service", "second");
    const first = await peer.nextEvent();
    const second = await peer.nextEvent();

    await peer.reply(second, { order: 2 });
    await peer.reply(first, { order: 1 });

    assert.deepEqual((await firstPromise).payload, { order: 1 });
    assert.deepEqual((await secondPromise).payload, { order: 2 });
    assert.equal(peer.connectionCount, 1);
});

test("short ClientConnection keeps one-request-per-socket behavior", async (t) => {
    const peer = await ControlPeer.create();
    const connection = client(peer.socketPath, "short");
    t.after(async () => {
        connection.close();
        await peer.close();
    });

    const firstPromise = connection.requestEvent("@control", "service", "first");
    const first = await peer.nextEvent();
    await peer.reply(first);
    await firstPromise;

    const secondPromise = connection.requestEvent("@control", "service", "second");
    const second = await peer.nextEvent();
    await peer.reply(second);
    await secondPromise;

    assert.equal(peer.connectionCount, 2);
});

test("persistent ClientConnection multiplexes streams and closes one stream without closing the socket", async (t) => {
    const peer = await ControlPeer.create();
    const connection = client(peer.socketPath);
    t.after(async () => {
        connection.close();
        await peer.close();
    });

    const firstPromise = connection.openStream("alpha" as never, "runtime", "subscribe", { fromSeq: 1 });
    const secondPromise = connection.openStream("beta" as never, "runtime", "subscribe", { fromSeq: 3 });
    const firstRequest = await peer.nextEvent();
    const secondRequest = await peer.nextEvent();
    await peer.openStream(firstRequest, "stream-first");
    await peer.openStream(secondRequest, "stream-second");
    const first = await firstPromise;
    const second = await secondPromise;

    await peer.sendStream(firstRequest, first.stream.id, "runtime.updated", { value: 1 });
    await peer.sendStream(secondRequest, second.stream.id, "runtime.updated", { value: 2 });
    assert.deepEqual((await first.stream.nextEvent()).payload, { value: 1 });
    assert.deepEqual((await second.stream.nextEvent()).payload, { value: 2 });

    first.stream.close();
    await assert.rejects(first.stream.nextEvent(), /closed/u);
    const cancel = await peer.nextEvent();
    assert.equal(cancel.event.name, "stream.cancel");
    assert.equal(cancel.event.streamId, first.stream.id);
    await peer.sendStream(firstRequest, first.stream.id, "stream.cancelled");

    await peer.sendStream(secondRequest, second.stream.id, "runtime.updated", { value: 3 });
    assert.deepEqual((await second.stream.nextEvent()).payload, { value: 3 });

    const requestPromise = connection.requestEvent("@control", "service", "ping");
    const request = await peer.nextEvent();
    await peer.reply(request, { pong: true });
    assert.deepEqual((await requestPromise).payload, { pong: true });
    assert.equal(peer.connectionCount, 1);
});

test("server cancellation terminates only the addressed persistent stream", async (t) => {
    const peer = await ControlPeer.create();
    const connection = client(peer.socketPath);
    t.after(async () => {
        connection.close();
        await peer.close();
    });

    const openedPromise = connection.openStream("alpha" as never, "runtime", "subscribe");
    const streamRequest = await peer.nextEvent();
    await peer.openStream(streamRequest, "stream-cancelled");
    const opened = await openedPromise;
    await streamRequest.codec.send({
        id: "cancelled-by-server",
        streamId: opened.stream.id,
        destination: streamRequest.event.destination,
        name: "stream.cancelled",
        error: {
            code: "stream.cancelled",
            message: "cancelled by server",
            retryable: false
        }
    });

    const cancelled = await opened.stream.nextEvent();
    assert.equal(cancelled.name, "stream.cancelled");
    assert.equal(cancelled.error?.message, "cancelled by server");
    await assert.rejects(opened.stream.nextEvent(), /closed/u);

    const requestPromise = connection.requestEvent("@control", "service", "ping");
    const request = await peer.nextEvent();
    await peer.reply(request, { pong: true });
    assert.deepEqual((await requestPromise).payload, { pong: true });
    assert.equal(peer.connectionCount, 1);
});

test("disconnect rejects every pending request and active stream waiter until explicit reconnect", async (t) => {
    const peer = await ControlPeer.create();
    const connection = client(peer.socketPath);
    t.after(async () => {
        connection.close();
        await peer.close();
    });

    const openedPromise = connection.openStream("alpha" as never, "runtime", "subscribe");
    const streamRequest = await peer.nextEvent();
    await peer.openStream(streamRequest, "stream-one");
    const opened = await openedPromise;
    const streamWaiter = opened.stream.nextEvent();

    const firstPending = connection.requestEvent("@control", "service", "first");
    const secondPending = connection.requestEvent("@control", "service", "second");
    await peer.nextEvent();
    await peer.nextEvent();
    peer.disconnectAll();

    await assert.rejects(firstPending, /closed|socket|connection/u);
    await assert.rejects(secondPending, /closed|socket|connection/u);
    await assert.rejects(streamWaiter, /closed|socket|connection/u);
    await assert.rejects(connection.requestEvent("@control", "service", "blocked"), /closed|socket|connection/u);

    await connection.reconnect();
    const recoveredPromise = connection.requestEvent("@control", "service", "ping");
    const recovered = await peer.nextEvent();
    await peer.reply(recovered, { pong: true });
    assert.deepEqual((await recoveredPromise).payload, { pong: true });
    assert.equal(peer.connectionCount, 2);
});

test("unexpected replyTo closes a persistent connection and rejects its pending requests", async (t) => {
    const peer = await ControlPeer.create();
    const connection = client(peer.socketPath);
    t.after(async () => {
        connection.close();
        await peer.close();
    });

    const firstPending = connection.requestEvent("@control", "service", "first");
    const secondPending = connection.requestEvent("@control", "service", "second");
    const received = await peer.nextEvent();
    await peer.nextEvent();
    await received.codec.send({
        id: "bad-reply",
        replyTo: "unknown-request",
        destination: "@control",
        name: "service.first"
    });

    await assert.rejects(firstPending, /Unexpected replyTo/u);
    await assert.rejects(secondPending, /Unexpected replyTo/u);
});
