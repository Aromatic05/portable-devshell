import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";

import { ReverseRpcSseChannel } from "../../../src/control/reverse/connection/SseChannel.ts";

class FakeServerResponse extends EventEmitter {
    writableEnded = false;
    endError?: Error;
    writeError?: Error;
    writeResult = true;
    readonly writes: string[] = [];

    end(): void {
        if (this.endError !== undefined) throw this.endError;
        this.writableEnded = true;
    }

    write(value: string): boolean {
        if (this.writeError !== undefined) throw this.writeError;
        this.writes.push(value);
        return this.writeResult;
    }
}

test("reverse SSE commits upstream sequence only after ordered raw payload delivery", () => {
    const response = new FakeServerResponse();
    const channel = new ReverseRpcSseChannel(
        response as unknown as ServerResponse,
    );
    const values: string[] = [];
    channel.onData((data) => values.push(Buffer.from(data).toString("utf8")));

    assert.throws(
        () => channel.acceptUpstream(2, Buffer.from("gap").toString("base64")),
        /gap/iu,
    );
    assert.equal(channel.acceptedUpstreamSeq, 0);

    const encoded = Buffer.from("response").toString("base64");
    assert.equal(channel.acceptUpstream(1, encoded), 1);
    assert.deepEqual(values, ["response"]);
    channel.close();
});

test("reverse SSE write failures close the channel", async () => {
    const response = new FakeServerResponse();
    response.writeError = new Error("SSE write failed");
    const channel = new ReverseRpcSseChannel(
        response as unknown as ServerResponse,
    );
    const closed = new Promise<Error | undefined>((resolve) =>
        channel.onClose(resolve),
    );

    await assert.rejects(
        channel.write(Buffer.from("request")),
        /SSE write failed/iu,
    );
    assert.match((await closed)?.message ?? "", /SSE write failed/iu);
    await assert.rejects(
        channel.write(Buffer.from("request")),
        /disconnected/iu,
    );
});

test("reverse SSE heartbeat write failures close the channel", async () => {
    const response = new FakeServerResponse();
    response.writeError = new Error("heartbeat write failed");
    const channel = new ReverseRpcSseChannel(
        response as unknown as ServerResponse,
        0,
        {
            heartbeatIntervalMs: 1,
            now: () => 42,
        },
    );
    const closed = new Promise<Error | undefined>((resolve) =>
        channel.onClose(resolve),
    );

    assert.match((await closed)?.message ?? "", /heartbeat write failed/iu);
});

test("reverse SSE close reports response.end failures", async () => {
    const response = new FakeServerResponse();
    response.endError = new Error("SSE end failed");
    const channel = new ReverseRpcSseChannel(
        response as unknown as ServerResponse,
    );
    const closed = new Promise<Error | undefined>((resolve) =>
        channel.onClose(resolve),
    );

    channel.close();

    assert.match((await closed)?.message ?? "", /SSE end failed/iu);
});

test("reverse SSE removes temporary drain listeners after backpressure clears", async () => {
    const response = new FakeServerResponse();
    response.writeResult = false;
    const channel = new ReverseRpcSseChannel(
        response as unknown as ServerResponse,
    );

    const sent = channel.write(Buffer.from("request"));
    assert.equal(response.listenerCount("drain"), 1);
    assert.equal(response.listenerCount("error"), 2);
    response.emit("drain");
    await sent;

    assert.equal(response.listenerCount("drain"), 0);
    assert.equal(response.listenerCount("error"), 1);
    channel.close();
});

test("reverse SSE rejects a backpressured send when the response closes", async () => {
    const response = new FakeServerResponse();
    response.writeResult = false;
    const channel = new ReverseRpcSseChannel(
        response as unknown as ServerResponse,
    );

    const sent = channel.write(Buffer.from("request"));
    assert.equal(response.listenerCount("close"), 2);
    response.emit("close");

    await assert.rejects(sent, /closed before drain/iu);
    assert.equal(response.listenerCount("drain"), 0);
    assert.equal(response.listenerCount("error"), 1);
    assert.equal(response.listenerCount("close"), 0);
});
