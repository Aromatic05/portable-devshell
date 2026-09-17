import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createConnection, createServer, type Server, Socket } from "node:net";
import { rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
    SocketChannel,
    StreamChannel,
    WebSocketServerChannel,
    type Channel,
} from "@portable-devshell/shared";
import { createTestIpcPath } from "../../../../../../test/TestPlatformSupport.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";

interface ListeningSocket {
    directory: string;
    server: Server;
    socketPath: string;
}

async function listen(): Promise<ListeningSocket> {
    const directory = await createTestTempDirectory("channel");
    const socketPath = createTestIpcPath("channel", directory);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });
    return { directory, server, socketPath };
}

async function closeListeningSocket(listening: ListeningSocket): Promise<void> {
    await new Promise<void>((resolve) =>
        listening.server.close(() => resolve()),
    );
    await rm(listening.directory, { force: true, recursive: true });
}

function onceConnection(server: Server): Promise<Socket> {
    return new Promise((resolve) => server.once("connection", resolve));
}

function onceData(channel: Channel): Promise<Uint8Array> {
    return new Promise((resolve) => {
        const remove = channel.onData((data) => {
            remove();
            resolve(data);
        });
    });
}

async function rawSocket(socketPath: string): Promise<Socket> {
    return await new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
    });
}

test("SocketChannel connect/accept exchanges raw bytes", async (t) => {
    const listening = await listen();
    const accepted = onceConnection(listening.server).then((socket) =>
        SocketChannel.accept(socket),
    );
    const client = await SocketChannel.connect(listening.socketPath);
    const service = await accepted;
    t.after(async () => {
        client.close();
        service.close();
        await closeListeningSocket(listening);
    });

    const received = onceData(service);
    await client.write(Buffer.from("hello"));
    assert.equal(Buffer.from(await received).toString("utf8"), "hello");
});

test("SocketChannel aborts and destroys a pending socket connection", async () => {
    const socket = new Socket();
    const controller = new AbortController();
    const reason = new Error("connection cancelled");
    const connecting = SocketChannel.connect("unused", {
        signal: controller.signal,
        socketFactory: () => socket,
    });

    controller.abort(reason);

    await assert.rejects(connecting, reason);
    assert.equal(socket.destroyed, true);
});

test("SocketChannel preserves byte order without interpreting chunk boundaries", async (t) => {
    const listening = await listen();
    const accepted = onceConnection(listening.server).then((socket) =>
        SocketChannel.accept(socket),
    );
    const socket = await rawSocket(listening.socketPath);
    const service = await accepted;
    t.after(async () => {
        socket.destroy();
        service.close();
        await closeListeningSocket(listening);
    });

    const received = new Promise<string>((resolve) => {
        let value = "";
        service.onData((data) => {
            value += Buffer.from(data).toString("utf8");
            if (value.length === 6) resolve(value);
        });
    });
    socket.write(Buffer.from("o"));
    socket.write(Buffer.from("ne"));
    socket.write(Buffer.from("two"));

    assert.equal(await received, "onetwo");
});

test("SocketChannel treats EOF as a normal close regardless of byte content", async (t) => {
    const listening = await listen();
    const accepted = onceConnection(listening.server).then((socket) =>
        SocketChannel.accept(socket),
    );
    const socket = await rawSocket(listening.socketPath);
    const service = await accepted;
    t.after(async () => {
        socket.destroy();
        service.close();
        await closeListeningSocket(listening);
    });

    const closed = new Promise<Error | undefined>((resolve) =>
        service.onClose(resolve),
    );
    socket.end(Buffer.from([0, 0, 0, 3, 1]));
    assert.equal(await closed, undefined);
});

test("SocketChannel serializes concurrent writes and rejects writes after close", async (t) => {
    const listening = await listen();
    const accepted = onceConnection(listening.server).then((socket) =>
        SocketChannel.accept(socket),
    );
    const client = await SocketChannel.connect(listening.socketPath);
    const service = await accepted;
    t.after(async () => {
        client.close();
        service.close();
        await closeListeningSocket(listening);
    });

    const bytes = new Promise<string>((resolve) => {
        let value = "";
        service.onData((data) => {
            value += Buffer.from(data).toString("utf8");
            if (value.length === 6) resolve(value);
        });
    });
    await Promise.all([
        client.write(Buffer.from("one")),
        client.write(Buffer.from("two")),
    ]);
    assert.equal(await bytes, "onetwo");

    client.close();
    await assert.rejects(client.write(Buffer.from("three")), /closed/i);
});

test("SocketChannel isolates late close listener failures", async (t) => {
    const listening = await listen();
    const accepted = onceConnection(listening.server).then((socket) =>
        SocketChannel.accept(socket),
    );
    const client = await SocketChannel.connect(listening.socketPath);
    const service = await accepted;
    t.after(async () => {
        client.close();
        service.close();
        await closeListeningSocket(listening);
    });
    const warnings: unknown[] = [];
    const originalEmitWarning = process.emitWarning;
    process.emitWarning = ((warning: string | Error) => {
        warnings.push(warning);
    }) as typeof process.emitWarning;
    try {
        client.close();
        let notified = 0;
        client.onClose(() => {
            throw new Error("late close listener failed");
        });
        client.onClose(() => {
            notified += 1;
        });
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(notified, 1);
        assert.equal(warnings.length, 1);
    } finally {
        process.emitWarning = originalEmitWarning;
    }
});

class MemoryChannel implements Channel {
    closed = false;
    readonly sent: Uint8Array[] = [];
    readonly #data = new Set<(data: Uint8Array) => void>();
    readonly #closed = new Set<(error?: Error) => void>();

    async write(data: Uint8Array): Promise<void> {
        this.sent.push(Uint8Array.from(data));
    }
    onData(listener: (data: Uint8Array) => void): () => void {
        this.#data.add(listener);
        return () => this.#data.delete(listener);
    }
    onClose(listener: (error?: Error) => void): () => void {
        this.#closed.add(listener);
        return () => this.#closed.delete(listener);
    }
    emit(data: Uint8Array): void {
        for (const listener of this.#data) listener(data);
    }
    close(error?: Error): void {
        this.closed = true;
        for (const listener of this.#closed) listener(error);
    }
}

class FakeServerWebSocket extends EventEmitter {
    readyState = 1;
    closeError?: Error;
    deferSend = false;
    pingError?: Error;
    sendError?: Error;
    readonly sendCallbacks: Array<(error?: Error) => void> = [];
    terminated = false;

    send(
        _data: Uint8Array,
        _options: { binary: true },
        callback: (error?: Error) => void,
    ): void {
        if (this.sendError !== undefined) throw this.sendError;
        if (this.deferSend) {
            this.sendCallbacks.push(callback);
            return;
        }
        callback();
    }

    completeSend(error?: Error): void {
        const callback = this.sendCallbacks.shift();
        assert.notEqual(callback, undefined);
        callback!(error);
    }

    close(code = 1000, reason = ""): void {
        if (this.closeError !== undefined) throw this.closeError;
        this.readyState = 3;
        this.emit("close", code, Buffer.from(reason));
    }

    message(data: unknown, isBinary: boolean): void {
        this.emit("message", data, isBinary);
    }

    ping(): void {
        if (this.pingError !== undefined) throw this.pingError;
    }

    terminate(): void {
        this.terminated = true;
        this.readyState = 3;
    }
}

test("StreamChannel preserves raw bytes and propagates writes", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let transportClosed = false;
    const stream = new StreamChannel(input, output, {
        closeTransport: () => {
            transportClosed = true;
        },
    });
    const incoming = new Promise<string>((resolve) =>
        stream.onData((data) => resolve(Buffer.from(data).toString())),
    );
    input.write(Buffer.from("incoming"));
    assert.equal(await incoming, "incoming");

    const outgoing = new Promise<Buffer>((resolve) =>
        output.once("data", resolve),
    );
    await stream.write(Buffer.from("outgoing"));
    assert.deepEqual(await outgoing, Buffer.from("outgoing"));
    stream.close();
    assert.equal(transportClosed, true);
});

test("WebSocketServerChannel owns shared send, close, heartbeat, and binary-frame lifecycle", async () => {
    const sendSocket = new FakeServerWebSocket();
    sendSocket.deferSend = true;
    const sendChannel = new WebSocketServerChannel(sendSocket);
    const sendClosed = new Promise<Error | undefined>((resolve) =>
        sendChannel.onClose(resolve),
    );
    const first = sendChannel.write(Buffer.from("one"));
    const second = sendChannel.write(Buffer.from("two"));
    await new Promise((resolve) => setImmediate(resolve));
    sendSocket.completeSend(new Error("send failed"));
    await assert.rejects(first, /send failed/iu);
    await assert.rejects(second, /send failed|closed/iu);
    assert.match((await sendClosed)?.message ?? "", /send failed/iu);
    assert.equal(sendSocket.terminated, true);

    const closeSocket = new FakeServerWebSocket();
    closeSocket.closeError = new Error("close failed");
    const closeChannel = new WebSocketServerChannel(closeSocket);
    const closeResult = new Promise<Error | undefined>((resolve) =>
        closeChannel.onClose(resolve),
    );
    closeChannel.close();
    assert.equal((await closeResult)?.message, "close failed");
    assert.equal(closeSocket.terminated, true);

    const textSocket = new FakeServerWebSocket();
    textSocket.closeError = new Error("close frame failed");
    const textChannel = new WebSocketServerChannel(textSocket);
    const textClosed = new Promise<Error | undefined>((resolve) =>
        textChannel.onClose(resolve),
    );
    textSocket.message("text", false);
    assert.notEqual(await textClosed, undefined);
    assert.equal(textChannel.closed, true);

    const heartbeatSocket = new FakeServerWebSocket();
    heartbeatSocket.pingError = new Error("ping failed");
    const heartbeatChannel = new WebSocketServerChannel(heartbeatSocket, {
        deadConnectionMs: 1_000,
        heartbeatIntervalMs: 1,
        now: () => 0,
    });
    assert.equal(
        (
            await new Promise<Error | undefined>((resolve) =>
                heartbeatChannel.onClose(resolve),
            )
        )?.message,
        "ping failed",
    );
    assert.equal(heartbeatSocket.terminated, true);
});

test("WebSocketServerChannel isolates late close listener failures", async () => {
    const socket = new FakeServerWebSocket();
    const channel = new WebSocketServerChannel(socket);
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (warning) => warnings.push(warning);
    try {
        channel.close();
        let notified = 0;
        channel.onClose(() => {
            throw new Error("late close listener failed");
        });
        channel.onClose(() => {
            notified += 1;
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(notified, 1);
        assert.equal(warnings.length, 1);
    } finally {
        console.warn = originalWarn;
    }
});
