import assert from "node:assert/strict";
import test from "node:test";

import { type Channel } from "@portable-devshell/shared";
import { EnvelopeCodec, type Envelope } from "@portable-devshell/shared/testing";

class FragmentChannel implements Channel {
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #dataListeners = new Set<(data: Uint8Array) => void>();
    #closed = false;
    #peer?: FragmentChannel;

    get closed(): boolean {
        return this.#closed;
    }

    connect(peer: FragmentChannel): void {
        this.#peer = peer;
    }

    async write(data: Uint8Array): Promise<void> {
        const peer = this.#peer;
        if (this.#closed || peer === undefined || peer.#closed)
            throw new Error("Channel is closed.");
        for (const byte of data) peer.#accept(Uint8Array.of(byte));
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
        for (const listener of this.#closeListeners) listener(error);
        if (this.#peer !== undefined) this.#peer.#remoteClose(error);
    }

    inject(data: Uint8Array): void {
        this.#accept(data);
    }

    #accept(data: Uint8Array): void {
        if (this.#closed) return;
        for (const listener of this.#dataListeners) listener(data);
    }

    #remoteClose(error?: Error): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const listener of this.#closeListeners) listener(error);
    }
}

test("EnvelopeCodec restores byte-at-a-time fragmentation", async () => {
    const left = new FragmentChannel();
    const right = new FragmentChannel();
    left.connect(right);
    right.connect(left);
    const sender = new EnvelopeCodec(left);
    const receiver = new EnvelopeCodec(right);
    const received = new Promise<Envelope>((resolve) =>
        receiver.onEnvelope(resolve),
    );
    const envelope: Envelope = {
        source: { host: "a", port: "tool" },
        dest: { host: "b", port: "tool" },
        packet: { protocol: "event", name: "progress", message: { value: 1 } },
    };
    await sender.send(envelope);
    assert.deepEqual(await received, envelope);
});

test("EnvelopeCodec preserves raw Stream DATA bytes", async () => {
    const left = new FragmentChannel();
    const right = new FragmentChannel();
    left.connect(right);
    right.connect(left);
    const sender = new EnvelopeCodec(left);
    const receiver = new EnvelopeCodec(right);
    const received = new Promise<Envelope>((resolve) =>
        receiver.onEnvelope(resolve),
    );
    const envelope: Envelope = {
        source: { host: "a", port: "process" },
        dest: { host: "b", port: "process" },
        packet: {
            protocol: "stream",
            type: "data",
            id: "stream-1",
            seq: 1,
            bytes: Uint8Array.of(0, 1, 2, 254, 255),
        },
    };
    await sender.send(envelope);
    assert.deepEqual(await received, envelope);
});

test("EnvelopeCodec closes malformed wire envelopes", async () => {
    const channel = new FragmentChannel();
    const codec = new EnvelopeCodec(channel);
    const closed = new Promise<Error | undefined>((resolve) =>
        codec.onClose(resolve),
    );
    channel.inject(Uint8Array.of(0));
    assert.match((await closed)?.message ?? "", /Envelope source/u);
});
