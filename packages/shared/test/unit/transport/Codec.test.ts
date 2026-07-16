import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { asInstanceName, Channel, Codec, type Frame } from "@portable-devshell/shared";

interface CodecPair {
    client: Codec;
    clientChannel: Channel;
    directory: string;
    listener: Server;
    server: Codec;
    serverChannel: Channel;
}

async function pair(): Promise<CodecPair> {
    const directory = await mkdtemp(join(tmpdir(), "portable-devshell-codec-"));
    const socketPath = join(directory, "codec.sock");
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(socketPath, resolve);
    });
    const accepted = new Promise<Channel>((resolve) => listener.once("connection", (socket) => resolve(Channel.accept(socket))));
    const clientChannel = await Channel.connect(socketPath);
    const serverChannel = await accepted;
    return {
        client: new Codec(clientChannel, { local: "tui", remote: "server" }),
        clientChannel,
        directory,
        listener,
        server: new Codec(serverChannel, { local: "server" }),
        serverChannel
    };
}

async function closePair(value: CodecPair): Promise<void> {
    value.client.close();
    value.server.close();
    await new Promise<void>((resolve) => value.listener.close(() => resolve()));
    await rm(value.directory, { force: true, recursive: true });
}

function onceFrame(codec: Codec): Promise<Frame> {
    return new Promise((resolve) => {
        const remove = codec.onFrame((frame) => {
            remove();
            resolve(frame);
        });
    });
}

test("Codec round-trips Frame/Event and binds the first server peer", async (t) => {
    const value = await pair();
    t.after(() => closePair(value));
    const incoming = onceFrame(value.server);
    await value.client.send({
        id: "tui-1",
        event: {
            destination: asInstanceName("aromatic-pc"),
            name: "todo.get",
            payload: {}
        }
    });

    assert.deepEqual(await incoming, {
        id: "tui-1",
        from: "tui",
        to: "server",
        event: {
            destination: "aromatic-pc",
            name: "todo.get",
            payload: {}
        }
    });
    assert.equal(value.server.remotePeer, "tui");
});

test("Codec preserves replyTo, streamId, error, and seq", async (t) => {
    const value = await pair();
    t.after(() => closePair(value));
    const binding = onceFrame(value.server);
    await value.client.send({
        id: "bind-1",
        event: { destination: "@control", name: "service.ping" }
    });
    await binding;

    const incoming = onceFrame(value.client);
    await value.server.send({
        id: "server-1",
        replyTo: "bind-1",
        streamId: "bind-1",
        event: {
            destination: "@control",
            name: "service.ping",
            seq: 3,
            error: { code: "test.failed", message: "failed", retryable: false }
        }
    });

    const frame = await incoming;
    assert.equal(frame.replyTo, "bind-1");
    assert.equal(frame.streamId, "bind-1");
    assert.equal(frame.event.seq, 3);
    assert.equal(frame.event.error?.code, "test.failed");
});

test("Codec rejects invalid operation names before sending", async (t) => {
    const value = await pair();
    t.after(() => closePair(value));

    await assert.rejects(
        value.client.send({
            id: "bad",
            event: {
                destination: "@control",
                name: "three.segment.name" as "service.ping"
            }
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

test("Codec rejects a peer change after first-frame binding", async (t) => {
    const value = await pair();
    t.after(() => closePair(value));
    const binding = onceFrame(value.server);
    await value.client.send({ id: "bind", event: { destination: "@control", name: "service.ping" } });
    await binding;
    const closed = new Promise<Error | undefined>((resolve) => value.server.onClose(resolve));

    await value.clientChannel.send(Buffer.from(JSON.stringify({
        id: "spoof",
        from: "cli",
        to: "server",
        event: { destination: "@control", name: "service.ping" }
    }), "utf8"));

    assert.equal((await closed as { code?: string } | undefined)?.code, "protocol.invalidDirection");
});
