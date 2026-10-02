import assert from "node:assert/strict";
import test from "node:test";

import {
    createControlClients,
    Endpoint,
    Rpc,
    Stream,
} from "@portable-devshell/shared";

test("tool clients send calls to control ingress and sessions/history to the instance", async (t) => {
    const endpoint = new Endpoint({ host: "native-client" });
    const connections: Array<{ host: string; port: string }> = [];
    endpoint.connect = async (host, port) => {
        connections.push({ host, port });
        return endpoint.bind(`client-${port}`).connect(host, port);
    };
    const payloads: unknown[] = [];
    const controlPort = endpoint.bind("tool", "@control");
    const calls = new Rpc(controlPort, {
        call: (payload) => {
            payloads.push(payload);
            return { ok: true };
        },
    });
    const streams = new Stream(controlPort);
    streams.onOpen(async (stream, name, payload) => {
        assert.equal(name, "callStream");
        payloads.push(payload);
        await new Promise<void>((resolve) => setImmediate(resolve));
        await stream.send({ name: "progress", payload: { step: 1 } });
        await stream.close({ ok: true });
    });
    const sessions = new Rpc(endpoint.bind("tool", "existing"), {
        openSession: (payload) => {
            payloads.push(payload);
            return { tools: [], workspace: "/canonical" };
        },
        closeSession: (payload) => {
            payloads.push(payload);
            return {};
        },
        listCalls: (payload) => {
            payloads.push(payload);
            return [];
        },
    });
    t.after(() => {
        streams.close();
        calls.close();
        sessions.close();
        endpoint.close();
    });
    const clients = createControlClients(endpoint, { clientKind: "cli" });
    assert.deepEqual(await clients.tool.call("nonexistent", "file_read", { path: "a" }, "/workspace"), { ok: true });
    const progress: unknown[] = [];
    assert.deepEqual(await clients.tool.callStreaming("nonexistent", "file_read", { path: "b" }, "/workspace", {
        operationId: "operation-1",
        recording: "caller",
        onProgress: (value) => progress.push(value),
    }), { ok: true });
    assert.deepEqual(progress, [{ step: 1 }]);
    assert.deepEqual(await clients.tool.openSession("existing", "/requested"), { tools: [], workspace: "/canonical" });
    assert.deepEqual(await clients.tool.closeSession("existing"), {});
    assert.deepEqual(await clients.tool.listCalls("existing", { limit: 5 }), []);
    assert.deepEqual(connections, [
        { host: "@control", port: "tool" },
        { host: "@control", port: "tool" },
        { host: "existing", port: "tool" },
        { host: "existing", port: "tool" },
        { host: "existing", port: "tool" },
    ]);
    assert.deepEqual(payloads, [
        { instance: "nonexistent", toolName: "file_read", input: { path: "a" }, workspace: "/workspace" },
        { instance: "nonexistent", toolName: "file_read", input: { path: "b" }, workspace: "/workspace", operationId: "operation-1", recording: "caller" },
        { workspace: "/requested" },
        {},
        { limit: 5 },
    ]);
});
