import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
    ClientStream,
    type ClientConnection,
    type ControlClients,
} from "@portable-devshell/shared";

import { createCliRuntimeAdapter } from "../../src/client/CliRuntimeAdapter.ts";

test("interactive start surfaces relay send failure and restores terminal state", { timeout: 1_000 }, async () => {
    const rawModes: boolean[] = [];
    const input = new EventEmitter() as EventEmitter & NodeJS.ReadableStream & {
        isRaw?: boolean;
        isTTY?: boolean;
        setRawMode(mode: boolean): void;
    };
    input.isRaw = false;
    input.isTTY = true;
    input.setRawMode = (mode) => {
        input.isRaw = mode;
        rawModes.push(mode);
    };

    let closeCount = 0;
    const stream = new ClientStream("relay-test", {
        close() {
            closeCount += 1;
        },
        async nextEvent() {
            return await new Promise<never>(() => undefined);
        },
        async send() {
            throw new Error("relay send failed");
        },
    });
    const runtime = {
        async openStart() {
            return { acknowledgement: {} as never, stream };
        },
    } as unknown as ControlClients["runtime"];
    const connection = {
        mapError(error: unknown) {
            return error instanceof Error ? error : new Error(String(error));
        },
    } as unknown as ClientConnection;
    const adapter = createCliRuntimeAdapter(connection, runtime);

    const started = adapter.start("alpha", {
        input,
        output: { write() {} },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.emit("data", Buffer.from("input"));

    await assert.rejects(started, /relay send failed/u);
    assert.deepEqual(rawModes, [true, false]);
    assert.equal(closeCount, 1);
    assert.equal(input.listenerCount("data"), 0);
    assert.equal(input.listenerCount("end"), 0);
});
