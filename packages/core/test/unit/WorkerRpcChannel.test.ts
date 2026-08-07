import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
    WorkerRpcProcessConnector,
    decodeWorkerRpcMessage,
} from "@portable-devshell/core/testing";


test("WorkerRpcProcessConnector aborts immediately and kills a late process", async () => {
    let releaseSpawn!: () => void;
    let signalSpawnStarted!: () => void;
    let killCount = 0;
    const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    const spawnStarted = new Promise<void>((resolve) => { signalSpawnStarted = resolve; });
    const process = {
        exit: new Promise(() => undefined),
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill() { killCount += 1; return true; },
    };
    const connector = new WorkerRpcProcessConnector({
        async spawnWorkerRpc() {
            signalSpawnStarted();
            await spawnGate;
            return process;
        },
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

test("Worker RPC codec rejects invalid UTF-8", () => {
    const payload = Buffer.concat([
        Buffer.from('{"value":"', "utf8"),
        Buffer.from([0xff]),
        Buffer.from('"}', "utf8"),
    ]);
    assert.throws(
        () => decodeWorkerRpcMessage(payload),
        (error: unknown) => (error as { code?: string }).code === "protocol.invalidJson",
    );
});

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("operation did not settle")), 250);
            }),
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
