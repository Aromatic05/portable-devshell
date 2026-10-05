import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { WorkerToolCatalog } from "../../../../src/toolcall/worker/Catalog.ts";
import { WorkerToolInvoker } from "../../../../src/toolcall/worker/Invoker.ts";
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
    await client.connect("worker", "tool");
    await accepting;
    return { client, server };
}

test("WorkerToolInvoker treats current schemas as discovery metadata, not a wire firewall", async (t) => {
    const catalog = new WorkerToolCatalog();
    catalog.refresh([
        {
            requiredCapabilities: ["read"],
            description: "Read files in a batch.",
            group: "file",
            inputSchema: {
                type: "object",
                properties: {
                    files: {
                        type: "array",
                        minItems: 1,
                        items: {
                            type: "object",
                            properties: { path: { type: "string" } },
                            required: ["path"],
                            additionalProperties: false,
                        },
                    },
                },
                required: ["files"],
                additionalProperties: false,
            },
            name: "file_read",
            outputSchema: {
                type: "object",
                properties: { type: { enum: ["file"] } },
                required: ["type"],
                additionalProperties: false,
            },
        },
    ]);

    const { client, server } = await endpoints();
    const calls: unknown[] = [];
    const rpc = new Rpc(server.bind("tool"), {
        file_read: (message) => {
            const request = message as { input: unknown };
            calls.push(request.input);
            return { legacyContent: "1:legacy" };
        },
    });
    t.after(() => {
        rpc.close();
        client.close();
        server.close();
    });

    const invoker = new WorkerToolInvoker(client, "worker", catalog);
    assert.deepEqual(
        await invoker.invoke("file_read", {
            path: "./legacy.txt",
            view: "content",
        }),
        { legacyContent: "1:legacy" },
    );
    assert.deepEqual(calls, [{ path: "./legacy.txt", view: "content" }]);
});
