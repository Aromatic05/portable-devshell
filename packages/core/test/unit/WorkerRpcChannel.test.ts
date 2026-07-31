import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { WorkerRpcChannelBase } from "@portable-devshell/core";
import type { JsonValue } from "@portable-devshell/shared";
import { encodeFrame } from "@portable-devshell/shared/transport/frame";
import { WorkerRpcFrameReader } from "../../src/worker/rpc/WorkerRpcFrame.ts";
import {
    WorkerRpcProcessChannel,
    WorkerRpcProcessConnector
} from "../../src/worker/rpc/WorkerRpcProcessChannel.ts";

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

test("WorkerRpcProcessChannel disconnects when stdin writes fail", async () => {
    const stdin = new Writable({
        write(_chunk, _encoding, callback) {
            callback(new Error("stdin write failed"));
        }
    });
    const channel = new WorkerRpcProcessChannel({
        exit: new Promise(() => undefined),
        stdin,
        stdout: new PassThrough(),
        kill() { return true; }
    } as never);
    const disconnected = new Promise<unknown>((resolve) => channel.onDisconnect(resolve));

    await assert.rejects(channel.send({ type: "request" }), /stdin write failed/iu);
    assert.match(String(await disconnected), /stdin write failed/iu);
    await assert.rejects(channel.send({ type: "request" }), /disconnected/iu);
});

test("WorkerRpcProcessChannel reports kill failures as disconnects", async () => {
    const channel = new WorkerRpcProcessChannel({
        exit: new Promise(() => undefined),
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        kill() {
            throw new Error("kill failed");
        }
    } as never);
    const disconnected = new Promise<unknown>((resolve) => channel.onDisconnect(resolve));

    channel.close();

    assert.match(String(await disconnected), /kill failed/iu);
});

test("WorkerRpcProcessConnector aborts immediately and kills a late process", async () => {
    let releaseSpawn!: () => void;
    let signalSpawnStarted!: () => void;
    let killCount = 0;
    const spawnGate = new Promise<void>((resolve) => {
        releaseSpawn = resolve;
    });
    const spawnStarted = new Promise<void>((resolve) => {
        signalSpawnStarted = resolve;
    });
    const process = {
        exit: new Promise(() => undefined),
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill() {
            killCount += 1;
            return true;
        }
    };
    const connector = new WorkerRpcProcessConnector({
        async spawnWorkerRpc() {
            signalSpawnStarted();
            await spawnGate;
            return process;
        }
    } as never, { instanceName: "late-process" });
    const controller = new AbortController();
    const reason = new Error("spawn cancelled");
    const connecting = connector.connect(controller.signal);
    await spawnStarted;

    controller.abort(reason);

    await assert.rejects(withTimeout(connecting), reason);
    assert.equal(killCount, 0);
    releaseSpawn();
    await waitUntil(() => killCount === 1);
});

test("WorkerRpcFrameReader rejects invalid UTF-8 inside otherwise valid JSON", () => {
    const reader = new WorkerRpcFrameReader();
    const payload = Buffer.concat([
        Buffer.from('{"value":"', "utf8"),
        Buffer.from([0xff]),
        Buffer.from('"}', "utf8")
    ]);

    assert.throws(
        () => reader.push(encodeFrame(payload)),
        (error: unknown) => (error as { code?: string }).code === "protocol.invalidJson"
    );
});

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("operation did not settle")), 250);
            })
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for condition.");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
