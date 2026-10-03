import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
    WORKER_PROTOCOL_VERSION,
    WorkerProtocolClient,
} from "@portable-devshell/core/testing";
import {
    Endpoint,
    Rpc,
    StreamChannel,
    type Channel,
} from "@portable-devshell/shared";

function channelPair(): { client: Channel; server: Channel } {
    const leftToRight = new PassThrough();
    const rightToLeft = new PassThrough();
    let closed = false;
    let left: StreamChannel;
    let right: StreamChannel;
    const close = (error?: Error) => {
        if (closed) return;
        closed = true;
        left.close(error);
        right.close(error);
    };
    left = new StreamChannel(rightToLeft, leftToRight, {
        closeTransport: close,
    });
    right = new StreamChannel(leftToRight, rightToLeft, {
        closeTransport: close,
    });
    return { client: left, server: right };
}

async function endpoints(): Promise<{ client: Endpoint; server: Endpoint }> {
    const pair = channelPair();
    let connected = false;
    const client = new Endpoint({
        host: "control",
        connectChannel: async () => {
            assert.equal(connected, false);
            connected = true;
            return pair.client;
        },
    });
    const server = new Endpoint({ host: "worker" });
    const accepting = server.accept(pair.server);
    await client.connect("worker", "core");
    await accepting;
    return { client, server };
}

test("WorkerProtocolClient routes core and tool calls by Endpoint port", async (t) => {
    const { client, server } = await endpoints();
    t.after(() => {
        client.close();
        server.close();
    });

    const calls: string[] = [];
    const core = new Rpc(server.bind("core"), {
        "worker.ping": () => {
            calls.push("core:worker.ping");
            return { pong: true };
        },
        "worker.handshake": () => {
            calls.push("core:worker.handshake");
            return {
                protocolVersion: WORKER_PROTOCOL_VERSION,
                workerVersion: "test",
                workerSha256: null,
                platform: { arch: "x64", os: "linux" },
            };
        },
    });
    const tool = new Rpc(server.bind("tool"), {
        "tools.list": () => {
            calls.push("tool:tools.list");
            return { tools: [] };
        },
    });
    t.after(() => {
        core.close();
        tool.close();
    });

    const worker = new WorkerProtocolClient(client, "worker");
    assert.deepEqual(await worker.ping(), { pong: true });
    assert.equal(
        (
            await worker.handshake({
                protocolRange: {
                    min: WORKER_PROTOCOL_VERSION,
                    max: WORKER_PROTOCOL_VERSION,
                },
                clientName: "portable-devshell",
                clientVersion: "test",
            })
        ).protocolVersion,
        WORKER_PROTOCOL_VERSION,
    );
    assert.deepEqual(await worker.listTools(), { tools: [] });
    assert.deepEqual(calls, [
        "core:worker.ping",
        "core:worker.handshake",
        "tool:tools.list",
    ]);
});
