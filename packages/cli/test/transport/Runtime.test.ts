import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { Endpoint, PROCESS_PORT, type ProcessTransport } from "@portable-devshell/shared";
import { type Packet } from "@portable-devshell/shared/testing";

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

        const endpoint = new Endpoint({ host: "alpha" });
        const connection = await endpoint.connect("alpha", PROCESS_PORT);
        let sends = 0;
        const deliver = connection.send.bind(connection);
        connection.send = async (packet: Packet) => {
            sends += 1;
            if (sends > 1) throw new Error("relay send failed");
            await deliver(packet);
        };
        endpoint.connect = async () => connection;
        const adapter = createCliRuntimeAdapter(
            endpoint,
            {} as ProcessTransport,
        );

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
        endpoint.close();
    },
);
