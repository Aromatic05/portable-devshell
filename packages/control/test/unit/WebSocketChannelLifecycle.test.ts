import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";

import type { JsonValue } from "@portable-devshell/shared";
import WebSocket from "ws";

import { ReverseRpcFrameCodec } from "../../src/control/reverse/rpc/ReverseRpcFrameCodec.ts";
import { ReverseRpcSseChannel } from "../../src/control/reverse/rpc/ReverseRpcSseChannel.ts";
import { ReverseRpcWebSocketChannel } from "../../src/control/reverse/rpc/ReverseRpcWebSocketChannel.ts";
import { ControlWebSocketFrameChannel } from "../../src/server/web/ControlWebSocketFrameChannel.ts";

class FakeWebSocket extends EventEmitter {
    readyState: number = WebSocket.OPEN;
    closeError?: Error;
    deferSend = false;
    pingError?: Error;
    sendError?: Error;
    readonly sendCallbacks: Array<(error?: Error) => void> = [];
    terminated = false;

    close(code = 1000, reason = ""): void {
        if (this.closeError !== undefined) {
            throw this.closeError;
        }
        this.readyState = WebSocket.CLOSED;
        this.emit("close", code, Buffer.from(reason));
    }

    ping(): void {
        if (this.pingError !== undefined) {
            throw this.pingError;
        }
    }

    send(_data: unknown, _options: unknown, callback: (error?: Error) => void): void {
        if (this.sendError !== undefined) {
            throw this.sendError;
        }
        if (this.deferSend) {
            this.sendCallbacks.push(callback);
            return;
        }
        callback();
    }

    completeSend(error?: Error): void {
        const callback = this.sendCallbacks.shift();
        assert.notEqual(callback, undefined);
        callback!(error);
    }

    message(data: unknown, isBinary: boolean): void {
        this.emit("message", data, isBinary);
    }

    terminate(): void {
        this.terminated = true;
        this.readyState = WebSocket.CLOSED;
    }
}

class FakeServerResponse extends EventEmitter {
    writableEnded = false;
    endError?: Error;
    writeError?: Error;
    writeResult = true;
    readonly writes: string[] = [];

    end(): void {
        if (this.endError !== undefined) {
            throw this.endError;
        }
        this.writableEnded = true;
    }

    write(value: string): boolean {
        if (this.writeError !== undefined) {
            throw this.writeError;
        }
        this.writes.push(value);
        return this.writeResult;
    }
}

test("control WebSocket heartbeat converts ping races into channel closure", async () => {
    const socket = new FakeWebSocket();
    socket.pingError = new Error("ping failed");
    const channel = new ControlWebSocketFrameChannel(socket as unknown as WebSocket, {
        deadConnectionMs: 1_000,
        heartbeatIntervalMs: 1,
        now: () => 0
    });
    const closed = new Promise<Error | undefined>((resolve) => channel.onClose(resolve));

    const error = await closed;

    assert.equal(error?.message, "ping failed");
    assert.equal(channel.closed, true);
    assert.equal(socket.terminated, true);
});

test("control WebSocket close remains terminal when socket.close throws", async () => {
    const socket = new FakeWebSocket();
    socket.closeError = new Error("close failed");
    const channel = new ControlWebSocketFrameChannel(socket as unknown as WebSocket);
    const closed = new Promise<Error | undefined>((resolve) => channel.onClose(resolve));

    channel.close();
    const error = await closed;

    assert.equal(error?.message, "close failed");
    assert.equal(channel.closed, true);
    assert.equal(socket.terminated, true);
});

test("control WebSocket send failure closes the channel and rejects queued sends", async () => {
    const socket = new FakeWebSocket();
    socket.deferSend = true;
    const channel = new ControlWebSocketFrameChannel(socket as unknown as WebSocket);
    const closed = new Promise<Error | undefined>((resolve) => channel.onClose(resolve));

    const first = channel.send(new Uint8Array([1]));
    const second = channel.send(new Uint8Array([2]));
    await new Promise((resolve) => setImmediate(resolve));
    socket.completeSend(new Error("send callback failed"));

    await assert.rejects(first, /send callback failed/iu);
    await assert.rejects(second, /send callback failed/iu);
    assert.equal((await closed)?.message, "send callback failed");
    assert.equal(channel.closed, true);
    assert.equal(socket.terminated, true);
});

test("control WebSocket rejects text frames even when the close frame fails", async () => {
    const socket = new FakeWebSocket();
    socket.closeError = new Error("close frame failed");
    const channel = new ControlWebSocketFrameChannel(socket as unknown as WebSocket);
    const closed = new Promise<Error | undefined>((resolve) => channel.onClose(resolve));

    socket.message("not binary", false);

    assert.match((await closed)?.message ?? "", /requires binary RPC frames/iu);
    assert.equal(channel.closed, true);
});

test("reverse WebSocket heartbeat times out with a pending RPC request", async () => {
    let now = 0;
    const socket = new FakeWebSocket();
    const channel = new ReverseRpcWebSocketChannel(socket as unknown as WebSocket, {
        deadConnectionMs: 5,
        heartbeatIntervalMs: 1,
        now: () => now
    });
    const disconnected = new Promise<unknown>((resolve) => channel.onDisconnect(resolve));
    const request: JsonValue = {
        id: "request-1",
        method: "worker.ping",
        params: {},
        type: "request"
    };

    await channel.send(request);
    now = 10;
    const error = await disconnected;

    assert.match(String(error), /heartbeat timed out/iu);
    assert.equal(socket.terminated, true);
});

test("reverse WebSocket send failures disconnect and terminate the channel", async () => {
    const socket = new FakeWebSocket();
    socket.sendError = new Error("send failed");
    const channel = new ReverseRpcWebSocketChannel(socket as unknown as WebSocket);
    const disconnected = new Promise<unknown>((resolve) => channel.onDisconnect(resolve));
    const request: JsonValue = {
        id: "request-2",
        method: "worker.ping",
        params: {},
        type: "request"
    };

    await assert.rejects(channel.send(request), /send failed/iu);
    assert.match(String(await disconnected), /send failed/iu);
    assert.equal(socket.terminated, true);
});

test("reverse SSE commits upstream sequence only after decoding succeeds", () => {
    const response = new FakeServerResponse();
    const channel = new ReverseRpcSseChannel(response as unknown as ServerResponse);
    const messages: JsonValue[] = [];
    channel.onMessage((message) => messages.push(message));

    assert.throws(() => channel.acceptUpstream(1, "invalid-frame"), /frame|payload|length/iu);
    assert.equal(channel.acceptedUpstreamSeq, 0);

    const message: JsonValue = { id: "response-1", ok: true, result: {}, type: "response" };
    const frame = ReverseRpcFrameCodec.encode(message).toString("base64");
    assert.equal(channel.acceptUpstream(1, frame), 1);
    assert.deepEqual(messages, [message]);
    channel.close();
});

test("reverse SSE write failures disconnect the channel", async () => {
    const response = new FakeServerResponse();
    response.writeError = new Error("SSE write failed");
    const channel = new ReverseRpcSseChannel(response as unknown as ServerResponse);
    const disconnected = new Promise<unknown>((resolve) => channel.onDisconnect(resolve));

    await assert.rejects(channel.send({ type: "request" }), /SSE write failed/iu);
    assert.match(String(await disconnected), /SSE write failed/iu);
    await assert.rejects(channel.send({ type: "request" }), /disconnected/iu);
});

test("reverse SSE heartbeat write failures disconnect the channel", async () => {
    const response = new FakeServerResponse();
    response.writeError = new Error("heartbeat write failed");
    const channel = new ReverseRpcSseChannel(response as unknown as ServerResponse, 0, {
        heartbeatIntervalMs: 1,
        now: () => 42
    });
    const disconnected = new Promise<unknown>((resolve) => channel.onDisconnect(resolve));

    assert.match(String(await disconnected), /heartbeat write failed/iu);
});

test("reverse SSE close reports response.end failures", async () => {
    const response = new FakeServerResponse();
    response.endError = new Error("SSE end failed");
    const channel = new ReverseRpcSseChannel(response as unknown as ServerResponse);
    const disconnected = new Promise<unknown>((resolve) => channel.onDisconnect(resolve));

    channel.close();

    assert.match(String(await disconnected), /SSE end failed/iu);
});

test("reverse SSE removes temporary drain listeners after backpressure clears", async () => {
    const response = new FakeServerResponse();
    response.writeResult = false;
    const channel = new ReverseRpcSseChannel(response as unknown as ServerResponse);

    const sent = channel.send({ type: "request" });
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
    const channel = new ReverseRpcSseChannel(response as unknown as ServerResponse);

    const sent = channel.send({ type: "request" });
    assert.equal(response.listenerCount("close"), 2);
    response.emit("close");

    await assert.rejects(sent, /closed before drain/iu);
    assert.equal(response.listenerCount("drain"), 0);
    assert.equal(response.listenerCount("error"), 1);
    assert.equal(response.listenerCount("close"), 0);
});
