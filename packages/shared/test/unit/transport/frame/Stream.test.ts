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
    leftChannel: RecordingChannel;
    opener: FrameProtocol;
    acceptor: FrameProtocol;
} {
    const left = new RecordingChannel();
    const right = new RecordingChannel();
    left.connect(right);
    right.connect(left);
    return {
        leftChannel: left,
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
