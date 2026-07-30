import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { JsonValue } from "@portable-devshell/shared";
import WebSocket from "ws";

import { ReverseRpcWebSocketChannel } from "../../src/control/reverse/rpc/ReverseRpcWebSocketChannel.ts";
import { ControlWebSocketFrameChannel } from "../../src/server/web/ControlWebSocketFrameChannel.ts";

class FakeWebSocket extends EventEmitter {
    readyState = WebSocket.OPEN;
    closeError?: Error;
    pingError?: Error;
    sendError?: Error;
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
        callback();
    }

    terminate(): void {
        this.terminated = true;
        this.readyState = WebSocket.CLOSED;
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
