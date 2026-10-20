import assert from "node:assert/strict";
import test from "node:test";

import { ReverseConnections, type Instance, type ReverseConnectionIdentity } from "@portable-devshell/core";
import { asInstanceName, type Channel } from "@portable-devshell/shared";

class ChannelFixture implements Channel {
    closed = false;
    readonly #closeListeners = new Set<() => void>();
    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const listener of [...this.#closeListeners]) listener();
    }
    onClose(listener: () => void): () => void {
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }
    onData(): () => void { return () => undefined; }
    async write(): Promise<void> {}
}

test("a reverse attempt holding a retired instance descriptor is rejected before attach", async () => {
    let attachCount = 0;
    const current = descriptor(() => { attachCount += 1; });
    const retired = descriptor(() => { attachCount += 1; });
    const connections = new ReverseConnections({ instances: { get: () => current } });
    const candidate = new ChannelFixture();
    const staleIdentity: ReverseConnectionIdentity = { descriptor: retired, generation: 41 };

    await assert.rejects(
        connections.activate(staleIdentity, "wss", candidate),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "instance.conflict");
            return true;
        },
    );
    assert.equal(candidate.closed, true);
    assert.equal(attachCount, 0);
});

test("a stopped reverse service closes and rejects queued activation candidates", async () => {
    let entered!: () => void;
    let release!: () => void;
    const enteredAttach = new Promise<void>((resolve) => { entered = resolve; });
    const attachGate = new Promise<void>((resolve) => { release = resolve; });
    const instance = descriptor(async (_generation, signal) => {
        entered();
        await Promise.race([
            attachGate,
            new Promise<never>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
        ]);
    });
    const connections = new ReverseConnections({ instances: { get: () => instance } });
    const candidate = new ChannelFixture();
    const activation = connections.activate({ descriptor: instance, generation: 1 }, "wss", candidate);
    await enteredAttach;
    connections.stop();
    release();

    await assert.rejects(activation);
    assert.equal(candidate.closed, true);
});

function descriptor(
    onAttach: (generation: number, signal: AbortSignal) => void | Promise<void> = () => undefined,
): Instance {
    const value: Instance = {
        config: { name: asInstanceName("round4-reverse"), provider: "reverse" },
        lifecycle: {
            acquireLease() { return { instance: value, release() {} }; },
        },
        provision: {
            reverseConnection: {
                async attach(_channel: Channel, input: { generation: number; signal: AbortSignal }) {
                    await onAttach(input.generation, input.signal);
                },
            },
        },
    } as unknown as Instance;
    return value;
}
