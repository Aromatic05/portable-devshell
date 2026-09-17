import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { Channel } from "@portable-devshell/shared";
import {
    FrameProtocol,
    frameResetCodes,
    type FrameStream,
} from "@portable-devshell/shared/transport/frame";

const DEFAULT_MAX_ACTIVE_STREAMS = 256;

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

function pair(options: { maxDataSize?: number; receiveWindow?: number } = {}) {
    const left = new FragmentingChannel();
    const right = new FragmentingChannel();
    left.connect(right);
    right.connect(left);
    return {
        opener: new FrameProtocol(left, { role: "opener", ...options }),
        acceptor: new FrameProtocol(right, { role: "acceptor", ...options }),
    };
}

async function openPair(
    opener: FrameProtocol,
    acceptor: FrameProtocol,
    service: string,
    receiveWindow = 64 * 1024,
): Promise<{ local: FrameStream; remote: FrameStream }> {
    const local = await opener.open(service, new Uint8Array(), { receiveWindow });
    const request = await acceptor.nextOpen();
    assert.ok(request);
    const remote = await request.accept({ receiveWindow });
    return { local, remote };
}

function payload(byteLength: number, seed: number): Uint8Array {
    const data = new Uint8Array(byteLength);
    for (let index = 0; index < data.length; index += 1) {
        data[index] = (index * 31 + seed * 17) % 251;
    }
    return data;
}

function digest(data: Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
}

async function receive(stream: FrameStream): Promise<{ bytes: number; digest: string }> {
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
    writer: FrameStream,
    reader: FrameStream,
    data: Uint8Array,
): Promise<void> {
    const writing = writer.write(data).then(async () => await writer.finish());
    const received = await receive(reader);
    await writing;
    assert.equal(received.bytes, data.byteLength);
    assert.equal(received.digest, digest(data));
}

test("stress: default active-stream bound survives saturation and reuse", async () => {
    const { opener, acceptor } = pair();
    const streams: Array<{ local: FrameStream; remote: FrameStream }> = [];
    for (let index = 0; index < DEFAULT_MAX_ACTIVE_STREAMS; index += 1) {
        streams.push(await openPair(opener, acceptor, `saturation-${index}`, 1024));
    }
    await assert.rejects(
        opener.open("overflow", new Uint8Array(), { receiveWindow: 1024 }),
        /active stream limit/iu,
    );

    for (const stream of streams.slice(0, DEFAULT_MAX_ACTIVE_STREAMS / 2)) {
        await Promise.all([stream.local.finish(), stream.remote.finish()]);
        assert.equal(await stream.local.read(), undefined);
        assert.equal(await stream.remote.read(), undefined);
    }
    for (let index = 0; index < DEFAULT_MAX_ACTIVE_STREAMS / 2; index += 1) {
        const stream = await openPair(opener, acceptor, `reuse-${index}`, 1024);
        await transfer(stream.local, stream.remote, Uint8Array.of(index & 0xff));
        await stream.remote.finish();
        assert.equal(await stream.local.read(), undefined);
    }
});

test("stress: thousands of fragmented open/data/FIN cycles do not leak stream state", async () => {
    const { opener, acceptor } = pair({ maxDataSize: 128, receiveWindow: 512 });
    for (let index = 0; index < 4000; index += 1) {
        const stream = await openPair(opener, acceptor, `churn-${index}`, 512);
        await transfer(stream.local, stream.remote, payload(384, index));
        await stream.remote.finish();
        assert.equal(await stream.local.read(), undefined);
    }
    const final = await openPair(opener, acceptor, "after-churn", 512);
    await transfer(final.local, final.remote, payload(4096, 91));
});

test("stress: many concurrent bidirectional streams preserve data under fragmentation", async () => {
    const { opener, acceptor } = pair({ maxDataSize: 8 * 1024, receiveWindow: 32 * 1024 });
    const streams = await Promise.all(
        Array.from({ length: 48 }, (_, index) =>
            openPair(opener, acceptor, `parallel-${index}`, 32 * 1024),
        ),
    );
    await Promise.all(
        streams.flatMap((stream, index) => [
            transfer(stream.local, stream.remote, payload(256 * 1024, index)),
            transfer(stream.remote, stream.local, payload(256 * 1024, index + 1000)),
        ]),
    );
    for (const stream of streams) {
        assert.equal(stream.local.closed, true);
        assert.equal(stream.remote.closed, true);
    }
});

test("stress: an 8 MiB stalled stream cannot starve sibling streams", async () => {
    const { opener, acceptor } = pair({ maxDataSize: 8 * 1024, receiveWindow: 16 * 1024 });
    const slow = await openPair(opener, acceptor, "slow", 16 * 1024);
    const slowPayload = payload(8 * 1024 * 1024, 77);
    let slowFinished = false;
    const slowWrite = slow.local
        .write(slowPayload)
        .then(async () => await slow.local.finish())
        .then(() => {
            slowFinished = true;
        });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(slowFinished, false);

    const siblings = await Promise.all(
        Array.from({ length: 32 }, (_, index) =>
            openPair(opener, acceptor, `sibling-${index}`, 16 * 1024),
        ),
    );
    await Promise.all(
        siblings.map((stream, index) =>
            transfer(stream.local, stream.remote, payload(128 * 1024, index + 5000)),
        ),
    );
    assert.equal(slowFinished, false);

    const received = await receive(slow.remote);
    await slowWrite;
    assert.equal(received.bytes, slowPayload.byteLength);
    assert.equal(received.digest, digest(slowPayload));
});

test("stress: repeated RESET races release blocked writers and preserve siblings", async () => {
    const { opener, acceptor } = pair({ maxDataSize: 64, receiveWindow: 64 });
    const sibling = await openPair(opener, acceptor, "sibling", 64);

    for (let index = 0; index < 1000; index += 1) {
        const stream = await openPair(opener, acceptor, `reset-${index}`, 64);
        const writing = stream.local.write(payload(4096, index));
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        if (index % 2 === 0) {
            await stream.remote.reset(frameResetCodes.cancelled, "stress reset");
        } else {
            await stream.local.reset(frameResetCodes.cancelled, "stress reset");
        }
        await assert.rejects(writing, /reset|closed/iu);

        if (index % 100 === 0) {
            await sibling.local.write(Uint8Array.of(index / 100));
            assert.deepEqual(
                await sibling.remote.read(),
                Uint8Array.of(index / 100),
            );
        }
    }

    await sibling.local.write(Uint8Array.of(0xaa, 0xbb));
    assert.deepEqual(await sibling.remote.read(), Uint8Array.of(0xaa, 0xbb));
});
