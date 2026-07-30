import assert from "node:assert/strict";
import test from "node:test";

import { WorkerRpcChannelBase } from "@portable-devshell/core";
import type { JsonValue } from "@portable-devshell/shared";

class TestWorkerRpcChannel extends WorkerRpcChannelBase {
    async send(): Promise<void> {}

    close(): void {
        this.disconnect(new Error("closed"));
    }

    publish(message: JsonValue): void {
        this.emitMessage(message);
    }

    disconnect(error: unknown, cleanup?: () => void): void {
        this.notifyDisconnect(error, cleanup);
    }
}

test("WorkerRpcChannelBase isolates message listener failures", () => {
    const channel = new TestWorkerRpcChannel();
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (warning) => warnings.push(warning);
    try {
        const received: JsonValue[] = [];
        channel.onMessage(() => {
            throw new Error("broken message listener");
        });
        channel.onMessage((message) => received.push(message));

        channel.publish({ value: 1 });

        assert.deepEqual(received, [{ value: 1 }]);
        assert.equal(warnings.length, 1);
    } finally {
        console.warn = originalWarn;
    }
});

test("WorkerRpcChannelBase isolates disconnect cleanup and listeners", async () => {
    const channel = new TestWorkerRpcChannel();
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (warning) => warnings.push(warning);
    try {
        const error = new Error("disconnected");
        const received: unknown[] = [];
        channel.onDisconnect(() => {
            throw new Error("broken disconnect listener");
        });
        channel.onDisconnect((value) => received.push(value));

        channel.disconnect(error, () => {
            throw new Error("cleanup failed");
        });
        let lateMessages = 0;
        channel.onMessage(() => {
            lateMessages += 1;
        });
        channel.publish({ ignored: true });
        channel.onDisconnect((value) => received.push(value));
        await new Promise((resolve) => setImmediate(resolve));

        assert.deepEqual(received, [error, error]);
        assert.equal(lateMessages, 0);
        assert.equal(warnings.length, 2);
    } finally {
        console.warn = originalWarn;
    }
});
