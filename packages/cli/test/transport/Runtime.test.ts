import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { ControlClients, MessageStream } from "@portable-devshell/shared";

import { createCliRuntimeAdapter } from "../../src/transport/Runtime.js";

test(
    "interactive start surfaces relay send failure and restores terminal state",
    { timeout: 1_000 },
    async () => {
        const rawModes: boolean[] = [];
        const input = new EventEmitter() as EventEmitter &
            NodeJS.ReadableStream & {
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

        const stream = {
            onCancel() {
                return () => undefined;
            },
            onClose() {
                return () => undefined;
            },
            onData() {
                return () => undefined;
            },
            async send() {
                throw new Error("relay send failed");
            },
        } as unknown as MessageStream;
        const runtime = {
            async openStart() {
                return stream;
            },
        } as unknown as ControlClients["runtime"];
        const adapter = createCliRuntimeAdapter(runtime);

        const started = adapter.start("alpha", {
            input,
            output: { write() {} },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        input.emit("data", Buffer.from("input"));

        await assert.rejects(started, /relay send failed/u);
        assert.deepEqual(rawModes, [true, false]);
        assert.equal(input.listenerCount("data"), 0);
        assert.equal(input.listenerCount("end"), 0);
    },
);
