import assert from "node:assert/strict";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { Endpoint, Rpc, Stream, StreamChannel, asInstanceName, runtimeErrorCodes, type JsonValue } from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { createAuditRuntime } from "../../../src/audit/index.ts";
import { createWorkerArtifact } from "../../../src/instance/transport/packet/Artifact.ts";
import { WorkerProtocolClient } from "../../../src/instance/transport/packet/Client.ts";
import { TransportConnection } from "../../../src/instance/transport/endpoint/Connection.ts";
import { resolveWorkerInstanceConfig } from "../../../src/instance/runtime/provision/Config.ts";
import { WorkerInstance } from "../../../src/instance/runtime/index.ts";
import { InstanceEventBuffer } from "../../../src/instance/runtime/supervision/Event.ts";
import { InstanceStateMachine } from "../../../src/instance/runtime/supervision/State.ts";

function endpoints(t: TestContext) {
    const outgoing = new PassThrough();
    const incoming = new PassThrough();
    const clientChannel = new StreamChannel(incoming, outgoing);
    const serverChannel = new StreamChannel(outgoing, incoming);
    const client = new Endpoint({ host: "control", connectChannel: async () => clientChannel });
    const server = new Endpoint({ host: "alpha-worker" });
    const accepting = server.accept(serverChannel);
    t.after(() => { client.close(); server.close(); outgoing.destroy(); incoming.destroy(); });
    return { client, server, accepting };
}

const descriptor = { mediaType: "application/octet-stream", name: "result.bin", payloadBlake3: "a".repeat(64), payloadBytes: 4, type: "file" as const };

test("worker artifact routes payload and receive lifecycle operations to the artifact port", async t => {
    const { client, server, accepting } = endpoints(t);
    const calls: Array<[string, unknown]> = [];
    const rpc = new Rpc(server.bind("artifact"), {
        "artifact.payload.open": input => { calls.push(["open", input]); return { descriptor, expiresAtMs: 100, payloadId: "payload-1" }; },
        "artifact.payload.close": input => { calls.push(["close", input]); return {}; },
        "artifact.receive.begin": input => { calls.push(["begin", input]); return { nextOffsetBytes: 0, receiveId: "receive-1" }; },
        "artifact.receive.finish": input => { calls.push(["finish", input]); return { blake3: "a".repeat(64), bytes: 4, receiveId: "receive-1", targetPath: "/tmp/result.bin" }; },
        "artifact.receive.abort": input => { calls.push(["abort", input]); return {}; },
    });
    t.after(() => rpc.close());
    const artifact = createWorkerArtifact(client, "alpha-worker");
    const openInput = { expiresAtMs: 100, path: "./result.bin", workspace: "/workspace" };
    const beginInput = { descriptor, overwrite: false, targetPath: "/tmp/result.bin", workspace: "/tmp" };
    assert.equal((await artifact.openArtifactPayload(openInput)).payloadId, "payload-1");
    await accepting;
    await artifact.closeArtifactPayload("payload-1");
    assert.equal((await artifact.beginArtifactReceive(beginInput)).receiveId, "receive-1");
    assert.equal((await artifact.finishArtifactReceive("receive-1")).bytes, 4);
    await artifact.abortArtifactReceive("receive-2");
    assert.deepEqual(calls, [["open", openInput], ["close", { payloadId: "payload-1" }], ["begin", beginInput], ["finish", { receiveId: "receive-1" }], ["abort", { receiveId: "receive-2" }]]);
});

test("worker artifact transfers payload bytes and receive offsets through streams", async t => {
    const { client, server } = endpoints(t);
    const calls: Array<[string, unknown]> = [];
    const streams = new Stream(server.bind("artifact"));
    t.after(() => streams.close());
    streams.onOpen(async (stream, operation, input) => {
        calls.push([operation, input]);
        if (operation === "payload.read") {
            await stream.write(new Uint8Array([0x65, 0x73, 0x74]));
            await stream.close({ eof: true, offsetBytes: 1, payloadId: "payload-1", returnedBytes: 3, totalBytes: 4 });
            return;
        }
        assert.equal(operation, "receive.write");
        const chunk = await stream.readMessage();
        assert.equal(chunk.type, "data");
        assert.deepEqual((chunk as { bytes: Uint8Array }).bytes, new Uint8Array([0x74, 0x65, 0x73, 0x74]));
        assert.deepEqual(await stream.readMessage(), { type: "fin" });
        await stream.close({ nextOffsetBytes: 8, receivedBytes: 8, receiveId: "receive-1" });
    });
    const artifact = createWorkerArtifact(client, "alpha-worker");
    const readInput = { maxBytes: 3, offsetBytes: 1, payloadId: "payload-1" };
    assert.deepEqual((await artifact.readArtifactPayload(readInput)).bytes, new Uint8Array([0x65, 0x73, 0x74]));
    assert.equal((await artifact.writeArtifactReceive({ bytes: new Uint8Array([0x74, 0x65, 0x73, 0x74]), offsetBytes: 4, receiveId: "receive-1" })).nextOffsetBytes, 8);
    assert.deepEqual(calls, [["payload.read", readInput], ["receive.write", { offsetBytes: 4, receiveId: "receive-1" }]]);
});

test("worker rejects artifact calls before opening a port when it is not ready", async t => {
    const name = asInstanceName("alpha");
    let connections = 0;
    const endpoint = new Endpoint({ host: "control", connectChannel: async () => { connections += 1; throw new Error("must not connect"); } });
    const transportConnection = new TransportConnection(async () => { throw new Error("must not connect"); });
    const worker = new WorkerInstance({
        config: resolveWorkerInstanceConfig({ managementMode: "selfManaged", name, transportConnection }),
        endpoint, events: new InstanceEventBuffer(name, 16), protocolClient: new WorkerProtocolClient(endpoint, "alpha-worker"),
        stateMachine: new InstanceStateMachine(name), transportConnection,
    });
    t.after(() => worker.close());
    await assert.rejects(worker.artifact.openArtifactPayload({ expiresAtMs: 100, path: "./result.bin", workspace: "/workspace" }), { code: runtimeErrorCodes.instanceNotReady });
    assert.equal(connections, 0);
});

test("audit persists instance lifecycle events across runtime reopening", async t => {
    const root = await createTestTempDirectory("instance-audit-");
    const options = { instanceName: asInstanceName("alpha"), filePath: join(root, "audit.sqlite3"), eventBufferSize: 16 };
    const audit = createAuditRuntime(options);
    t.after(() => audit.close());
    const inputs: Array<{ type: string; data: JsonValue }> = [
        { type: "mcp.sessionOpened", data: { sessionId: "session-1" } },
        { type: "mcp.toolCalled", data: { ctxId: "ctx-1", source: "mcp", toolName: "bash_run" } },
        { type: "mcp.toolCalled", data: { requestId: "request-1", source: "mcp", toolName: "file_read" } },
        { type: "mcp.sessionClosed", data: { sessionId: "session-1" } },
    ];
    const records = inputs.map((record, index) => ({ ...record, at: new Date().toISOString(), instanceName: options.instanceName, seq: index + 1 }));
    for (const record of records) await audit.api.events.append(record);
    await audit.close();
    const reopened = createAuditRuntime(options);
    t.after(() => reopened.close());
    assert.deepEqual(reopened.api.events.readFrom(1), records);
    assert.equal(reopened.api.events.readHighWater(), 4);
});

test("closing audit drains admitted writes and rejects further writes", async t => {
    const root = await createTestTempDirectory("instance-audit-close-");
    const options = { instanceName: asInstanceName("alpha"), filePath: join(root, "audit.sqlite3"), eventBufferSize: 16 };
    const audit = createAuditRuntime(options);
    const state = audit.api.state<{ value: number }>("test-state");
    const writing = state.put("key", { value: 7 });
    const closing = audit.close();
    await Promise.all([writing, closing]);
    await assert.rejects(state.put("late", { value: 8 }), /closing/);
    await assert.rejects(audit.api.events.append({ at: new Date().toISOString(), instanceName: options.instanceName, seq: 1, type: "late" }), /closing/);
    const reopened = createAuditRuntime(options);
    t.after(() => reopened.close());
    assert.deepEqual(await reopened.api.state<{ value: number }>("test-state").get("key"), { value: 7 });
});
