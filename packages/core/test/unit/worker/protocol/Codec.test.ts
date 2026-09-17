import assert from "node:assert/strict";
import test from "node:test";

import {
    decodeWorkerRpcMessage,
    encodeWorkerRpcMessage,
} from "@portable-devshell/core/testing";

test("Worker RPC codec rejects invalid UTF-8", () => {
    const payload = Buffer.concat([
        Buffer.from('{"value":"', "utf8"),
        Buffer.from([0xff]),
        Buffer.from('"}', "utf8"),
    ]);
    assert.throws(
        () => decodeWorkerRpcMessage(payload),
        (error: unknown) =>
            (error as { code?: string }).code === "protocol.invalidJson",
    );
});

test("Worker RPC codec round-trips a protocol message", () => {
    const message = {
        id: "codec-roundtrip",
        method: "worker.ping",
        params: {},
        type: "request",
    } as const;
    assert.deepEqual(
        decodeWorkerRpcMessage(encodeWorkerRpcMessage(message)),
        message,
    );
});
