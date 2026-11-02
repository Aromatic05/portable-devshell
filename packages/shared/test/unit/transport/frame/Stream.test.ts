import assert from "node:assert/strict";
import test from "node:test";

import type { Channel } from "@portable-devshell/shared";
import {
    FRAME_MAX_DATA_SIZE,
    FrameBuffer,
    FrameProtocol,
    FrameResetError,
    FrameStreamChannel,
    frameResetCodes,
    type Frame,
    type FrameStream,
} from "@portable-devshell/shared/transport/frame";

class RecordingChannel implements Channel {
    readonly writes: Uint8Array[] = [];
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #dataListeners = new Set<(data: Uint8Array) => void>();
    #closed = false;
    #peer?: RecordingChannel;
    #heldWrites?: Uint8Array[];

    get closed(): boolean {
        return this.#closed;
    }

    connect(peer: RecordingChannel): void {
        this.#peer = peer;
    }

    async write(data: Uint8Array): Promise<void> {
        if (this.#closed) throw new Error("recording channel is closed");
        const copy = Uint8Array.from(data);
        this.writes.push(copy);
        const peer = this.#peer;
        if (peer === undefined || peer.#closed) throw new Error("peer closed");
        if (this.#heldWrites !== undefined) {
            this.#heldWrites.push(copy);
            return;
        }
        queueMicrotask(() => peer.#accept(copy));
    }

    holdWrites(): void {
        this.#heldWrites = [];
    }

    flushWrites(): void {
        const writes = this.#heldWrites;
        const peer = this.#peer;
        assert.ok(writes);
        assert.ok(peer);
        this.#heldWrites = undefined;
        peer.#accept(Buffer.concat(writes));
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
    leftChannel: RecordingChannel;
    rightChannel: RecordingChannel;
    opener: FrameProtocol;
    acceptor: FrameProtocol;
} {
    const left = new RecordingChannel();
    const right = new RecordingChannel();
    left.connect(right);
    right.connect(left);
    return {
        leftChannel: left,
        rightChannel: right,
        opener: new FrameProtocol(left, { role: "opener" }),
        acceptor: new FrameProtocol(right, { role: "acceptor" }),
    };
}

async function open(
    opener: FrameProtocol,
    acceptor: FrameProtocol,
    service: string,
    receiveWindow = 32,
): Promise<{ local: FrameStream; remote: FrameStream }> {
    const local = await opener.open(service, new Uint8Array(), {
        receiveWindow,
    });
    const request = await acceptor.nextOpen();
    assert.ok(request);
    const remote = await request.accept({ receiveWindow });
    return { local, remote };
}

function decodeWrites(writes: Uint8Array[]): Frame[] {
    const decoder = new FrameBuffer();
    return writes.flatMap((value) => decoder.push(value));
}

async function readText(stream: FrameStream): Promise<string> {
    const decoder = new TextDecoder();
    let value = "";
    while (true) {
        const chunk = await stream.read();
        if (chunk === undefined) return value;
        value += decoder.decode(chunk, { stream: true });
    }
}

test("DATA write emits bounded chunks for the single stream", async () => {
    const { leftChannel, opener, acceptor } = pair();
    const streamBytes = FRAME_MAX_DATA_SIZE * 3;
    const first = await open(opener, acceptor, "first", streamBytes);
    leftChannel.writes.length = 0;

    await first.local.write(new Uint8Array(streamBytes));

    const data = decodeWrites(leftChannel.writes).filter(
        (frame): frame is Extract<Frame, { type: "data" }> =>
            frame.type === "data",
    );
    assert.deepEqual(
        data.map((frame) => [frame.streamId, frame.data.byteLength]),
        [
            [1, FRAME_MAX_DATA_SIZE],
            [1, FRAME_MAX_DATA_SIZE],
            [1, FRAME_MAX_DATA_SIZE],
        ],
    );
});

test("FIN is a half-close and the opposite direction remains writable", async () => {
    const { opener, acceptor } = pair();
    const { local, remote } = await open(opener, acceptor, "half-close", 8);

    await local.write(new TextEncoder().encode("request"));
    await local.finish();
    assert.equal(await readText(remote), "request");

    await remote.write(new TextEncoder().encode("response"));
    await remote.finish();
    assert.equal(await readText(local), "response");
    assert.equal(local.closed, true);
    assert.equal(remote.closed, true);
});

test("FrameStreamChannel maps remote FIN to full logical close", async () => {
    const { opener, acceptor } = pair();
    const { local, remote } = await open(opener, acceptor, "channel-close", 8);
    const channel = new FrameStreamChannel(local);

    const received = new Promise<string>((resolve) => {
        let value = "";
        channel.onData((data) => {
            value += new TextDecoder().decode(data);
        });
        channel.onClose(() => resolve(value));
    });

    await remote.write(new TextEncoder().encode("done"));
    await remote.finish();

    assert.equal(await received, "done");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(local.closed, true);
    assert.equal(remote.closed, true);
});

test("RESET aborts both directions without closing FrameProtocol", async () => {
    const { opener, acceptor } = pair();
    const first = await open(opener, acceptor, "first", 8);

    await first.local.reset(frameResetCodes.cancelled, "cancelled");
    await assert.rejects(first.remote.read(), (error: unknown) => {
        assert.ok(error instanceof FrameResetError);
        assert.equal(error.resetCode, frameResetCodes.cancelled);
        return true;
    });
    await assert.rejects(first.local.write(Uint8Array.of(1)), /reset|closed/iu);
    assert.equal(opener.closed, false);
    assert.equal(acceptor.closed, false);
});

test("RESET releases a backpressured write and pending read without closing the protocol", async (t) => {
    const { opener, acceptor } = pair();
    t.after(() => { opener.close(); acceptor.close(); });
    const blocked = await open(opener, acceptor, "blocked", 1);
    await blocked.local.write(Uint8Array.of(1));
    let settled = false;
    const writing = blocked.local.write(Uint8Array.of(2)).finally(() => {
        settled = true;
    });
    const rejected = assert.rejects(writing, (error: unknown) => {
        assert.ok(error instanceof FrameResetError);
        assert.equal(error.resetCode, frameResetCodes.cancelled);
        return true;
    });
    const reading = assert.rejects(blocked.local.read(), (error: unknown) => {
        assert.ok(error instanceof FrameResetError);
        assert.equal(error.resetCode, frameResetCodes.cancelled);
        return true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "the peer has not consumed its receive window");
    await blocked.remote.reset(frameResetCodes.cancelled, "reader cancelled");
    await rejected;
    await reading;
    assert.equal(blocked.local.closed, true);
    await assert.rejects(blocked.remote.write(Uint8Array.of(8)), /reset|closed/iu);
    assert.equal(opener.closed, false);
    assert.equal(acceptor.closed, false);
});

test("receive window backpressure releases the next write when the peer consumes data", async (t) => {
    const { opener, acceptor } = pair();
    t.after(() => { opener.close(); acceptor.close(); });
    const { local, remote } = await open(opener, acceptor, "window-release", 1);
    await local.write(Uint8Array.of(1));
    let released = false;
    const secondWrite = local.write(Uint8Array.of(2)).then(() => { released = true; });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(released, false);
    assert.deepEqual(await remote.read(), Uint8Array.of(1));
    await secondWrite;
    assert.deepEqual(await remote.read(), Uint8Array.of(2));
});

test("pending readers receive consecutive DATA in wire order", async (t) => {
    const { opener, acceptor } = pair();
    t.after(() => { opener.close(); acceptor.close(); });
    const { local, remote } = await open(opener, acceptor, "reader-order", 8);
    const first = remote.read();
    const second = remote.read();

    await local.write(Uint8Array.of(0x31, 0x32));

    assert.deepEqual(await first, Uint8Array.of(0x31, 0x32));
    await local.write(Uint8Array.of(0x33));
    assert.deepEqual(await second, Uint8Array.of(0x33));
});

test("FIN resolves all pending readers after queued DATA", async (t) => {
    const { opener, acceptor } = pair();
    t.after(() => { opener.close(); acceptor.close(); });
    const { local, remote } = await open(opener, acceptor, "fin-pending-readers", 8);
    await local.write(Uint8Array.of(7));
    const first = remote.read();
    const second = remote.read();
    await local.finish();

    assert.deepEqual(await first, Uint8Array.of(7));
    assert.equal(await second, undefined);
});

test("batched DATA and FIN settle concurrent readers without resetting or releasing opposite credit", async (t) => {
    const { leftChannel, rightChannel, opener, acceptor } = pair();
    const sibling = pair();
    t.after(() => {
        opener.close(); acceptor.close();
        sibling.opener.close(); sibling.acceptor.close();
    });
    const { local, remote } = await open(opener, acceptor, "batched-fin", 1);
    const independent = await open(sibling.opener, sibling.acceptor, "independent", 1);
    await remote.write(Uint8Array.of(8));
    let writeSettled = false;
    const blockedWrite = remote.write(Uint8Array.of(9)).then(() => {
        writeSettled = true;
    });
    const results: (Uint8Array | undefined)[] = [];
    const first = remote.read().then((value) => { results.push(value); return value; });
    const second = remote.read().then((value) => { results.push(value); return value; });
    leftChannel.holdWrites();
    await local.write(Uint8Array.of(7));
    await local.finish();
    rightChannel.writes.length = 0;
    leftChannel.flushWrites();

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(results, [Uint8Array.of(7), undefined]);
    assert.deepEqual(await Promise.all([first, second]), [Uint8Array.of(7), undefined]);
    assert.equal(await remote.read(), undefined);
    assert.equal(writeSettled, false, "FIN must leave the opposite write waiting for WINDOW");
    assert.deepEqual(rightChannel.writes, [], "consumption after FIN sends neither WINDOW nor RESET");
    assert.equal(local.closed, false);
    assert.equal(remote.closed, false);

    await independent.local.write(Uint8Array.of(3));
    assert.deepEqual(await independent.remote.read(), Uint8Array.of(3));
    await independent.remote.write(Uint8Array.of(4));
    assert.deepEqual(await independent.local.read(), Uint8Array.of(4));
    assert.equal(writeSettled, false);

    assert.deepEqual(await local.read(), Uint8Array.of(8));
    await blockedWrite;
    assert.equal(writeSettled, true);
    assert.deepEqual(await local.read(), Uint8Array.of(9));
    await remote.finish();
    assert.equal(await local.read(), undefined);
    assert.equal(local.closed, true);
    assert.equal(remote.closed, true);
    assert.equal(opener.closed, false);
    assert.equal(acceptor.closed, false);
    assert.equal(sibling.opener.closed, false);
    assert.equal(sibling.acceptor.closed, false);
    assert.deepEqual(results, [Uint8Array.of(7), undefined]);
});

test("batched FIN preserves queued DATA until consumption", async (t) => {
    const { leftChannel, rightChannel, opener, acceptor } = pair();
    t.after(() => { opener.close(); acceptor.close(); });
    const { local, remote } = await open(opener, acceptor, "queued-batched-fin", 3);
    const first = remote.read();
    leftChannel.holdWrites();
    await local.write(Uint8Array.of(1));
    await local.write(Uint8Array.of(2));
    await local.write(Uint8Array.of(3));
    await local.finish();
    rightChannel.writes.length = 0;
    leftChannel.flushWrites();

    assert.deepEqual(await first, Uint8Array.of(1));
    const second = remote.read();
    const third = remote.read();
    const eof = remote.read();
    assert.deepEqual(await Promise.all([second, third, eof]), [Uint8Array.of(2), Uint8Array.of(3), undefined]);
    assert.deepEqual(rightChannel.writes, []);
    assert.equal(opener.closed, false);
    assert.equal(acceptor.closed, false);
});

test("reset rejects an already pending read with its remote error", async (t) => {
    const { opener, acceptor } = pair();
    t.after(() => { opener.close(); acceptor.close(); });
    const { local, remote } = await open(opener, acceptor, "pending-reset", 8);
    const pending = remote.read();
    const rejected = assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof FrameResetError);
        assert.equal(error.resetCode, frameResetCodes.cancelled);
        assert.equal(error.message, "reader cancelled");
        return true;
    });

    await local.reset(frameResetCodes.cancelled, "reader cancelled");
    await rejected;
});

test("CHANNEL remote FIN closes with a zero-credit write and queued waiters", { timeout: 3000 }, async (t) => {
    const { opener, acceptor } = pair();
    t.after(() => { opener.close(); acceptor.close(); });
    const { local, remote } = await open(opener, acceptor, "fin-blocked-write", 8);
    const channel = new FrameStreamChannel(local);
    const closed = new Promise<Error | undefined>((resolve) => channel.onClose(resolve));
    const writing = assert.rejects(channel.write(new Uint8Array(9)), /Channel closed/u);
    const queued = assert.rejects(channel.write(Uint8Array.of(1)), /closed/u);
    const finishing = assert.rejects(local.finish(), /closed/u);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(channel.closed, false);
    // The peer leaves all eight received bytes unread and returns no WINDOW.
    await remote.write(Uint8Array.of(7));
    await remote.finish();
    assert.equal(await closed, undefined);
    await Promise.all([writing, queued, finishing]);
    assert.equal(channel.closed, true);
    assert.equal(local.closed, true);
    assert.equal(opener.closed, false);
    assert.equal(acceptor.closed, false);
    await assert.rejects(remote.read(), /Channel closed/u);
});
