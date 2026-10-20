import assert from "node:assert/strict";
import test from "node:test";
import { CONTROL_PROTOCOL_VERSION, Endpoint, ChannelBase, Rpc, asInstanceName, type Channel } from "@portable-devshell/shared";
import { createCliClients, negotiateCliControl, CliClientEventStream } from "../../src/transport/Client.ts";
import { followCliCommandWatchStream } from "../../src/command/instance/observe/Stream.ts";

test("round6 CLI: reconnect replaces shared endpoint and reloads current instance snapshot", async () => {
    let connections = 0;
    let listCalls = 0;
    const serverEndpoints: Endpoint[] = [];
    const clients = createCliClients({ connectChannel: async () => {
        connections += 1;
        const [clientChannel, serverChannel] = channelPair();
        const endpoint = new Endpoint();
        serverEndpoints.push(endpoint);
        const serverRpc = new Rpc(endpoint.bind("server", "@control"), {
            hello: () => ({ capabilities: ["request", "stream", "streamResume"], protocolVersion: CONTROL_PROTOCOL_VERSION }),
        });
        const instanceRpc = new Rpc(endpoint.bind("instance", "@control"), {
            listInstances: () => {
                listCalls += 1;
                return [{ mcpEnabled: true, name: "alpha", snapshot: { connectionState: "connected", daemonState: "running", lastSeq: 9, name: "alpha", ready: true, status: "running" } }];
            },
        });
        void endpoint.accept(serverChannel);
        void serverRpc;
        void instanceRpc;
        return clientChannel;
    } });
    try {
        await negotiateCliControl(clients);
        await clients.reconnect();
        const snapshot = await clients.instance.listInstances();
        assert.equal(connections, 2);
        assert.equal(listCalls, 1);
        assert.equal(snapshot[0]?.snapshot.lastSeq, 9);
        assert.equal(snapshot[0]?.snapshot.status, "running");
    } finally {
        clients.close();
        for (const endpoint of serverEndpoints) endpoint.close();
    }
});

test("round6 CLI: watch stream reloads snapshot cursor and replays after a retention gap", async () => {
    const requested: number[] = [];
    const observed: number[] = [];
    let cursor = 4;
    let snapshots = 0;
    let subscriptions = 0;
    await followCliCommandWatchStream({
        loadFromSeq: async () => { snapshots += 1; if (snapshots === 2) cursor = 6; return cursor; },
        maxEvents: 1,
        onEvent: async () => { observed.push(cursor); },
        subscribe: async (fromSeq) => {
            requested.push(fromSeq);
            subscriptions += 1;
            if (subscriptions === 1) {
                return new CliClientEventStream({
                    close() {},
                    async next() { return { gap: { fromSeq, lastSeq: 9, nextSeq: 7 }, kind: "gap" }; },
                });
            }
            return new CliClientEventStream({
                close() {},
                async next() {
                    cursor = 7;
                    return { kind: "event", event: { at: "2026-10-20T00:00:00Z", instanceName: asInstanceName("alpha"), seq: 7, type: "instance.started" } };
                },
            });
        },
    });
    assert.deepEqual(requested, [4, 6]);
    assert.deepEqual(observed, [7]);
    assert.equal(subscriptions, 2);
});

function channelPair(): [Channel, Channel] {
    const left = new MemoryChannel();
    const right = new MemoryChannel();
    left.peer = right;
    right.peer = left;
    return [left, right];
}

class MemoryChannel extends ChannelBase {
    peer!: MemoryChannel;

    async write(data: Uint8Array): Promise<void> {
        if (this.closed) throw new Error("memory channel is closed");
        this.peer.receive(data);
    }

    close(error?: Error): void {
        this.finish(error);
        this.peer.finish(error);
    }

    receive(data: Uint8Array): void {
        this.emitData(Uint8Array.from(data));
    }
}
