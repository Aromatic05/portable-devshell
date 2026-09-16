import assert from "node:assert/strict";
import test from "node:test";

import type { Channel } from "@portable-devshell/shared";
import {
    encodeFrame,
    FrameProtocol,
    type FrameStream,
} from "@portable-devshell/shared/transport/frame";

class MemoryChannel implements Channel {
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #dataListeners = new Set<(data: Uint8Array) => void>();
    #closed = false;
    #peer?: MemoryChannel;

    get closed(): boolean {
        return this.#closed;
    }

    connect(peer: MemoryChannel): void {
        this.#peer = peer;
    }

    async write(data: Uint8Array): Promise<void> {
        if (this.#closed) throw new Error("memory channel is closed");
        const peer = this.#peer;
        if (peer === undefined || peer.#closed) {
            throw new Error("memory channel peer is closed");
        }
        const copy = Uint8Array.from(data);
        queueMicrotask(() => peer.#accept(copy));
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

function pair(): {
    opener: FrameProtocol;
    acceptor: FrameProtocol;
    acceptorChannel: MemoryChannel;
} {
    const left = new MemoryChannel();
    const right = new MemoryChannel();
    left.connect(right);
    right.connect(left);
    return {
        opener: new FrameProtocol(left, { role: "opener" }),
        acceptor: new FrameProtocol(right, { role: "acceptor" }),
        acceptorChannel: right,
    };
}

async function openPair(
    opener: FrameProtocol,
    acceptor: FrameProtocol,
    service = "test.echo",
    receiveWindow = 4,
): Promise<{ local: FrameStream; remote: FrameStream }> {
    const local = await opener.open(service, Uint8Array.of(7), {
        receiveWindow,
    });
    const request = await acceptor.nextOpen();
    assert.notEqual(request, undefined);
    const remote = await request!.accept({ receiveWindow });
    return { local, remote };
}

test("FrameProtocol opens one Service stream and moves opaque bytes in both directions", async () => {
    const { opener, acceptor } = pair();
    const { local, remote } = await openPair(
        opener,
        acceptor,
        "network.tcp",
        8,
    );

    assert.equal(local.id, 1);
    assert.equal(remote.id, 1);
    assert.equal(remote.service, "network.tcp");
    assert.deepEqual(remote.metadata, Uint8Array.of(7));

    await local.write(new TextEncoder().encode("ping"));
    assert.equal(new TextDecoder().decode(await remote.read()), "ping");

    await remote.write(new TextEncoder().encode("pong"));
    assert.equal(new TextDecoder().decode(await local.read()), "pong");

    opener.close();
    acceptor.close();
});

test("per-stream credit blocks only the slow logical stream", async () => {
    const { opener, acceptor } = pair();
    const first = await openPair(opener, acceptor, "first", 2);
    const second = await openPair(opener, acceptor, "second", 2);

    let firstDone = false;
    const firstWrite = first.local.write(Uint8Array.of(1, 2, 3, 4)).then(() => {
        firstDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(firstDone, false);

    await second.local.write(Uint8Array.of(9, 8));
    assert.deepEqual(await second.remote.read(), Uint8Array.of(9, 8));
    assert.equal(firstDone, false);

    assert.deepEqual(await first.remote.read(), Uint8Array.of(1, 2));
    await firstWrite;
    assert.deepEqual(await first.remote.read(), Uint8Array.of(3, 4));

    opener.close();
    acceptor.close();
});

test("a late WINDOW for a closed stream does not close sibling streams", async () => {
    const { opener, acceptor, acceptorChannel } = pair();
    const first = await openPair(opener, acceptor, "first", 8);
    const sibling = await openPair(opener, acceptor, "sibling", 8);

    await first.local.finish();
    await first.remote.finish();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(first.local.closed, true);
    assert.equal(first.remote.closed, true);

    await acceptorChannel.write(
        encodeFrame({
            creditDelta: 1,
            streamId: first.local.id,
            type: "window",
        }),
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    assert.equal(opener.closed, false);
    assert.equal(acceptor.closed, false);
    await sibling.local.write(Uint8Array.of(9));
    assert.deepEqual(await sibling.remote.read(), Uint8Array.of(9));
});

test("FrameProtocol rejects OPEN in the wrong direction and closes the Channel", async () => {
    const left = new MemoryChannel();
    const right = new MemoryChannel();
    left.connect(right);
    right.connect(left);
    const first = new FrameProtocol(left, { role: "opener" });
    const second = new FrameProtocol(right, { role: "opener" });

    await first.open("invalid", new Uint8Array(), { receiveWindow: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(second.closed, true);
    assert.equal(first.closed, true);
});
