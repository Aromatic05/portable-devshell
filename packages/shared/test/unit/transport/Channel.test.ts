import assert from "node:assert/strict";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CHANNEL_MAX_FRAME_SIZE, Channel } from "@portable-devshell/shared";

interface ListeningSocket {
    directory: string;
    server: Server;
    socketPath: string;
}

async function listen(): Promise<ListeningSocket> {
    const directory = await mkdtemp(join(tmpdir(), "portable-devshell-channel-"));
    const socketPath = join(directory, "channel.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });
    return { directory, server, socketPath };
}

async function closeListeningSocket(listening: ListeningSocket): Promise<void> {
    await new Promise<void>((resolve) => listening.server.close(() => resolve()));
    await rm(listening.directory, { force: true, recursive: true });
}

function onceConnection(server: Server): Promise<Socket> {
    return new Promise((resolve) => server.once("connection", resolve));
}

function onceFrame(channel: Channel): Promise<Uint8Array> {
    return new Promise((resolve) => {
        const remove = channel.onFrame((frame) => {
            remove();
            resolve(frame);
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

test("Channel connect/accept exchanges length-prefixed frames", async (t) => {
    const listening = await listen();
    const accepted = onceConnection(listening.server).then((socket) => Channel.accept(socket));
    const client = await Channel.connect(listening.socketPath);
    const service = await accepted;
    t.after(async () => {
        client.close();
        service.close();
        await closeListeningSocket(listening);
    });

    const received = onceFrame(service);
    await client.send(Buffer.from("hello"));
    assert.equal(Buffer.from(await received).toString("utf8"), "hello");
});

test("Channel assembles partial headers and payloads and splits sticky frames", async (t) => {
    const listening = await listen();
    const accepted = onceConnection(listening.server).then((socket) => Channel.accept(socket));
    const socket = await rawSocket(listening.socketPath);
    const service = await accepted;
    t.after(async () => {
        socket.destroy();
        service.close();
        await closeListeningSocket(listening);
    });

    const frames = new Promise<string[]>((resolve) => {
        const values: string[] = [];
        service.onFrame((frame) => {
            values.push(Buffer.from(frame).toString("utf8"));
            if (values.length === 2) {
                resolve(values);
            }
        });
    });
    const first = Buffer.alloc(7);
    first.writeUInt32BE(3, 0);
    first.write("one", 4);
    const second = Buffer.alloc(7);
    second.writeUInt32BE(3, 0);
    second.write("two", 4);

    socket.write(first.subarray(0, 2));
    socket.write(first.subarray(2, 5));
    socket.write(Buffer.concat([first.subarray(5), second]));

    assert.deepEqual(await frames, ["one", "two"]);
});

test("Channel rejects oversized frame headers", async (t) => {
    const listening = await listen();
    const accepted = onceConnection(listening.server).then((socket) => Channel.accept(socket));
    const socket = await rawSocket(listening.socketPath);
    const service = await accepted;
    t.after(async () => {
        socket.destroy();
        service.close();
        await closeListeningSocket(listening);
    });

    const closed = new Promise<Error | undefined>((resolve) => service.onClose(resolve));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(CHANNEL_MAX_FRAME_SIZE + 1, 0);
    socket.write(header);

    assert.equal((await closed as { code?: string } | undefined)?.code, "protocol.frameTooLarge");
});

test("Channel treats EOF with a partial frame as an error", async (t) => {
    const listening = await listen();
    const accepted = onceConnection(listening.server).then((socket) => Channel.accept(socket));
    const socket = await rawSocket(listening.socketPath);
    const service = await accepted;
    t.after(async () => {
        socket.destroy();
        service.close();
        await closeListeningSocket(listening);
    });

    const closed = new Promise<Error | undefined>((resolve) => service.onClose(resolve));
    socket.end(Buffer.from([0, 0, 0, 3, 1]));

    assert.equal((await closed as { code?: string } | undefined)?.code, "protocol.invalidFrame");
});

test("Channel serializes concurrent sends and rejects sends after close", async (t) => {
    const listening = await listen();
    const accepted = onceConnection(listening.server).then((socket) => Channel.accept(socket));
    const client = await Channel.connect(listening.socketPath);
    const service = await accepted;
    t.after(async () => {
        client.close();
        service.close();
        await closeListeningSocket(listening);
    });

    const frames = new Promise<string[]>((resolve) => {
        const values: string[] = [];
        service.onFrame((frame) => {
            values.push(Buffer.from(frame).toString("utf8"));
            if (values.length === 2) {
                resolve(values);
            }
        });
    });
    await Promise.all([client.send(Buffer.from("one")), client.send(Buffer.from("two"))]);
    assert.deepEqual(await frames, ["one", "two"]);

    client.close();
    await assert.rejects(client.send(Buffer.from("three")), /closed/i);
});
