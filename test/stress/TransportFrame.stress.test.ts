import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
    Endpoint,
    Stream,
    type Channel,
    type MessageStream,
} from "@portable-devshell/shared";
import {
    FrameProtocol,
    type FrameStream,
} from "@portable-devshell/shared/transport/frame";

const PACKET_STREAM_SATURATION = 256;

class FragmentingChannel implements Channel {
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #dataListeners = new Set<(data: Uint8Array) => void>();
    readonly #fragmentSizes = [1, 7, 257, 4096, 65536];
    #closed = false;
    #fragmentIndex = 0;
    #peer?: FragmentingChannel;

    get closed(): boolean {
        return this.#closed;
    }

    connect(peer: FragmentingChannel): void {
        this.#peer = peer;
    }

    async write(data: Uint8Array): Promise<void> {
        if (this.#closed) throw new Error("stress channel is closed");
        const peer = this.#peer;
        if (peer === undefined || peer.#closed) throw new Error("stress peer is closed");
        let offset = 0;
        while (offset < data.byteLength) {
            const fragmentSize = this.#fragmentSizes[
                this.#fragmentIndex++ % this.#fragmentSizes.length
            ]!;
            const end = Math.min(data.byteLength, offset + fragmentSize);
            const copy = Uint8Array.from(data.subarray(offset, end));
            queueMicrotask(() => peer.#accept(copy));
            offset = end;
        }
    }

    onData(listener: (data: Uint8Array) => void): () => void {
        this.#dataListeners.add(listener);
        return () => this.#dataListeners.delete(listener);
    }

    onClose(listener: (error?: Error) => void): () => void {
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    close(error?: Error): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const listener of [...this.#closeListeners]) listener(error);
        const peer = this.#peer;
        if (peer !== undefined) queueMicrotask(() => peer.#remoteClose(error));
    }

    #accept(data: Uint8Array): void {
        if (this.#closed) return;
        for (const listener of [...this.#dataListeners]) listener(data);
    }

    #remoteClose(error?: Error): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const listener of [...this.#closeListeners]) listener(error);
    }
}

function channelPair(): [FragmentingChannel, FragmentingChannel] {
    const left = new FragmentingChannel();
    const right = new FragmentingChannel();
    left.connect(right);
    right.connect(left);
    return [left, right];
}

function framePair(receiveWindow = 64 * 1024) {
    const [left, right] = channelPair();
    return {
        opener: new FrameProtocol(left, { role: "opener", receiveWindow }),
        acceptor: new FrameProtocol(right, { role: "acceptor", receiveWindow }),
    };
}

async function openFramePair(
    opener: FrameProtocol,
    acceptor: FrameProtocol,
    receiveWindow = 64 * 1024,
): Promise<{ local: FrameStream; remote: FrameStream }> {
    const local = await opener.open("stress", new Uint8Array(), { receiveWindow });
    const request = await acceptor.nextOpen();
    assert.ok(request);
    const remote = await request.accept({ receiveWindow });
    return { local, remote };
}

async function endpointPair(): Promise<{
    client: Endpoint;
    clientStreams: Stream;
    server: Endpoint;
    serverStreams: Stream;
}> {
    const [left, right] = channelPair();
    let connected = false;
    const client = new Endpoint({
        host: "client",
        connectChannel: async () => {
            if (connected) throw new Error("stress Endpoint already connected");
            connected = true;
            return left;
        },
    });
    const server = new Endpoint({ host: "server" });
    const accepting = server.accept(right);
    const connection = await client.connect("server", "stress");
    await accepting;
    return {
        client,
        clientStreams: new Stream(connection),
        server,
        serverStreams: new Stream(server.bind("stress")),
    };
}

async function openPacketPair(
    client: Stream,
    server: Stream,
    name: string,
): Promise<{ local: MessageStream; remote: MessageStream }> {
    const opened = new Promise<MessageStream>((resolve) => {
        const off = server.onOpen((stream, openedName) => {
            if (openedName !== name) return;
            off();
            resolve(stream);
        });
    });
    const local = await client.open(name);
    return { local, remote: await opened };
}

function payload(byteLength: number, seed: number): Uint8Array {
    const data = new Uint8Array(byteLength);
    for (let index = 0; index < data.length; index += 1)
        data[index] = (index * 31 + seed * 17) % 251;
    return data;
}

function digest(data: Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
}

async function receive(
    stream: Pick<FrameStream, "read"> | Pick<MessageStream, "read">,
): Promise<{ bytes: number; digest: string }> {
    const hash = createHash("sha256");
    let bytes = 0;
    while (true) {
        const chunk = await stream.read();
        if (chunk === undefined) break;
        bytes += chunk.byteLength;
        hash.update(chunk);
    }
    return { bytes, digest: hash.digest("hex") };
}

async function transfer(
    writer: MessageStream,
    reader: MessageStream,
    data: Uint8Array,
): Promise<void> {
    const writing = writer.write(data).then(async () => await writer.finish());
    const received = await receive(reader);
    await writing;
    assert.equal(received.bytes, data.byteLength);
    assert.equal(received.digest, digest(data));
}

async function closePair(local: MessageStream, remote: MessageStream): Promise<void> {
    await Promise.all([local.close(), remote.close()]);
}

test("stress: single Frame stream bounds a stalled writer and preserves fragmented data", async () => {
    const { opener, acceptor } = framePair(64 * 1024);
    const stream = await openFramePair(opener, acceptor, 64 * 1024);
    const data = payload(8 * 1024 * 1024, 17);
    let finished = false;
    const writing = stream.local
        .write(data)
        .then(async () => await stream.local.finish())
        .then(() => {
            finished = true;
        });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(finished, false);
    const received = await receive(stream.remote);
    await writing;
    assert.equal(received.bytes, data.byteLength);
    assert.equal(received.digest, digest(data));
    opener.close();
    acceptor.close();
});

test("stress: 256 Packet streams survive saturation and reuse", async () => {
    const { client, clientStreams, server, serverStreams } = await endpointPair();
    const streams: Array<{ local: MessageStream; remote: MessageStream }> = [];
    for (let index = 0; index < PACKET_STREAM_SATURATION; index += 1)
        streams.push(await openPacketPair(clientStreams, serverStreams, "saturation-" + index));

    await Promise.all(
        streams.map(async (stream, index) => {
            await stream.local.write(Uint8Array.of(index & 0xff));
            assert.deepEqual(await stream.remote.read(), Uint8Array.of(index & 0xff));
            await closePair(stream.local, stream.remote);
        }),
    );

    for (let index = 0; index < PACKET_STREAM_SATURATION / 2; index += 1) {
        const stream = await openPacketPair(clientStreams, serverStreams, "reuse-" + index);
        await transfer(stream.local, stream.remote, Uint8Array.of(index & 0xff));
        await closePair(stream.local, stream.remote);
    }
    clientStreams.close();
    serverStreams.close();
    client.close();
    server.close();
});

test("stress: thousands of fragmented Packet Stream cycles do not leak logical state", async () => {
    const { client, clientStreams, server, serverStreams } = await endpointPair();
    for (let index = 0; index < 4000; index += 1) {
        const stream = await openPacketPair(clientStreams, serverStreams, "churn-" + index);
        await transfer(stream.local, stream.remote, payload(384, index));
        await closePair(stream.local, stream.remote);
    }
    const final = await openPacketPair(clientStreams, serverStreams, "after-churn");
    await transfer(final.local, final.remote, payload(4096, 91));
    await closePair(final.local, final.remote);
    clientStreams.close();
    serverStreams.close();
    client.close();
    server.close();
});

test("stress: concurrent bidirectional Packet Streams preserve data under fragmentation", async () => {
    const { client, clientStreams, server, serverStreams } = await endpointPair();
    const streams = [];
    for (let index = 0; index < 48; index += 1)
        streams.push(await openPacketPair(clientStreams, serverStreams, "parallel-" + index));
    await Promise.all(
        streams.flatMap((stream, index) => [
            transfer(stream.local, stream.remote, payload(256 * 1024, index)),
            transfer(stream.remote, stream.local, payload(256 * 1024, index + 1000)),
        ]),
    );
    await Promise.all(streams.map((stream) => closePair(stream.local, stream.remote)));
    clientStreams.close();
    serverStreams.close();
    client.close();
    server.close();
});

test("stress: a queued 8 MiB Packet Stream does not starve sibling streams", async () => {
    const { client, clientStreams, server, serverStreams } = await endpointPair();
    const slow = await openPacketPair(clientStreams, serverStreams, "slow");
    const slowPayload = payload(8 * 1024 * 1024, 77);
    await slow.local.write(slowPayload);
    await slow.local.finish();

    const siblings = [];
    for (let index = 0; index < 32; index += 1)
        siblings.push(await openPacketPair(clientStreams, serverStreams, "sibling-" + index));
    await Promise.all(
        siblings.map((stream, index) =>
            transfer(stream.local, stream.remote, payload(128 * 1024, index + 5000)),
        ),
    );
    const received = await receive(slow.remote);
    assert.equal(received.bytes, slowPayload.byteLength);
    assert.equal(received.digest, digest(slowPayload));

    await Promise.all([
        closePair(slow.local, slow.remote),
        ...siblings.map((stream) => closePair(stream.local, stream.remote)),
    ]);
    clientStreams.close();
    serverStreams.close();
    client.close();
    server.close();
});

test("stress: repeated Packet Stream cancellation preserves a sibling", async () => {
    const { client, clientStreams, server, serverStreams } = await endpointPair();
    const sibling = await openPacketPair(clientStreams, serverStreams, "sibling");
    for (let index = 0; index < 1000; index += 1) {
        const stream = await openPacketPair(clientStreams, serverStreams, "cancel-" + index);
        await stream.local.cancel({ message: "stress cancel" });
        await assert.rejects(stream.remote.read(), /stress cancel/u);

        if (index % 100 === 0) {
            await sibling.local.write(Uint8Array.of(index / 100));
            assert.deepEqual(await sibling.remote.read(), Uint8Array.of(index / 100));
        }
    }
    await sibling.local.write(Uint8Array.of(0xaa, 0xbb));
    assert.deepEqual(await sibling.remote.read(), Uint8Array.of(0xaa, 0xbb));
    await closePair(sibling.local, sibling.remote);
    clientStreams.close();
    serverStreams.close();
    client.close();
    server.close();
});
