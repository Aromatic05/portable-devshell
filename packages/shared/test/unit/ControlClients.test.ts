import assert from "node:assert/strict";
import test from "node:test";

import {
    createToolTransport,
    Endpoint,
    type JsonValue,
    Rpc,
    Stream,
} from "@portable-devshell/shared";

test("tool transport routes all operations through the target instance tool port", async (t) => {
    const endpoint = new Endpoint({ host: "native-client" });
    const connections: Array<{ host: string; port: string }> = [];
    endpoint.connect = async (host, port) => {
        connections.push({ host, port });
        return endpoint.bind(`client-${port}`).connect(host, port);
    };
    const payloads: unknown[] = [];
    const callPort = endpoint.bind("tool", "nonexistent");
    const calls = new Rpc(callPort, {
        call: (payload) => {
            payloads.push(payload);
            return { ok: true };
        },
    });
    const streams = new Stream(callPort);
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
    const nonexistent = createToolTransport(endpoint, "nonexistent");
    const existing = createToolTransport(endpoint, "existing");
    assert.deepEqual(
        await nonexistent.call("file_read", { path: "a" }, "/workspace"),
        { ok: true },
    );
    const progress: unknown[] = [];
    assert.deepEqual(
        await nonexistent.callStreaming(
            "file_read",
            { path: "b" },
            "/workspace",
            {
                operationId: "operation-1",
                recording: "caller",
                onProgress: (value: JsonValue) => progress.push(value),
            },
        ),
        { ok: true },
    );
    assert.deepEqual(progress, [{ step: 1 }]);
    assert.deepEqual(await existing.openSession("/requested"), {
        tools: [],
        workspace: "/canonical",
    });
    assert.deepEqual(await existing.closeSession(), {});
    assert.deepEqual(await existing.listCalls({ limit: 5 }), []);
    assert.deepEqual(connections, [
        { host: "nonexistent", port: "tool" },
        { host: "nonexistent", port: "tool" },
        { host: "existing", port: "tool" },
        { host: "existing", port: "tool" },
        { host: "existing", port: "tool" },
    ]);
    assert.deepEqual(payloads, [
        {
            toolName: "file_read",
            input: { path: "a" },
            workspace: "/workspace",
        },
        {
            toolName: "file_read",
            input: { path: "b" },
            workspace: "/workspace",
            operationId: "operation-1",
            recording: "caller",
        },
        { workspace: "/requested" },
        {},
        { limit: 5 },
    ]);
});
