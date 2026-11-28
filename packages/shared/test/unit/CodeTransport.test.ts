import assert from "node:assert/strict";
import test from "node:test";

import {
    createCodeTransport,
    Endpoint,
    Rpc,
    Stream,
    type CodeLogEntry,
} from "@portable-devshell/shared";

test("code transport streams eval logs, returns result, and describes dts", async (t) => {
    const endpoint = new Endpoint({ host: "native-client" });
    endpoint.connect = async (host, port) =>
        endpoint.bind(`client-${port}`).connect(host, port);
    const codePort = endpoint.bind("code", "@control");
    const payloads: unknown[] = [];
    const rpc = new Rpc(codePort, {
        describe: (payload) => {
            payloads.push(payload);
            return {
                dts: "declare const devshell: DevShellRoot;",
                namespaces: ["bash", "file", "instance"],
            };
        },
    });
    const streams = new Stream(codePort);
    streams.onOpen(async (stream, name, payload) => {
        assert.equal(name, "eval");
        payloads.push(payload);
        await new Promise<void>((resolve) => setImmediate(resolve));
        await stream.send({
            name: "log",
            payload: { level: "log", text: "hello", timestampMs: 100 },
        });
        await stream.close({
            hasValue: true,
            logs: [{ level: "log", text: "hello", timestampMs: 100 }],
            meta: {
                callId: "code-1",
                durationMs: 12,
                toolCalls: 1,
                truncatedLogs: false,
                truncatedValue: false,
            },
            value: { ok: true },
        });
    });
    t.after(() => {
        streams.close();
        rpc.close();
        endpoint.close();
    });

    const transport = createCodeTransport(endpoint);
    const described = await transport.describe({ target: "file" });
    assert.deepEqual(described, {
        dts: "declare const devshell: DevShellRoot;",
        namespaces: ["bash", "file", "instance"],
    });

    const streamedLogs: CodeLogEntry[] = [];
    const result = await transport.eval(
        { instance: "demo-local", source: "return { ok: true };", workspace: "/repo" },
        { onLog: (entry) => streamedLogs.push(entry) },
    );
    assert.deepEqual(streamedLogs, [
        { level: "log", text: "hello", timestampMs: 100 },
    ]);
    assert.deepEqual(result, {
        hasValue: true,
        logs: [{ level: "log", text: "hello", timestampMs: 100 }],
        meta: {
            callId: "code-1",
            durationMs: 12,
            toolCalls: 1,
            truncatedLogs: false,
            truncatedValue: false,
        },
        value: { ok: true },
    });
    assert.deepEqual(payloads, [
        { target: "file" },
        { instance: "demo-local", source: "return { ok: true };", workspace: "/repo" },
    ]);
});

test("code transport cancels open eval stream on AbortSignal", async (t) => {
    const endpoint = new Endpoint({ host: "native-client" });
    endpoint.connect = async (host, port) =>
        endpoint.bind(`client-${port}`).connect(host, port);
    const codePort = endpoint.bind("code", "@control");
    let cancelled = false;
    const streams = new Stream(codePort);
    streams.onOpen(async (stream) => {
        stream.onCancel(() => {
            cancelled = true;
        });
        await new Promise<void>((resolve) => {
            stream.onCancel(() => resolve());
            stream.onClose(() => resolve());
        });
    });
    t.after(() => {
        streams.close();
        endpoint.close();
    });

    const controller = new AbortController();
    const transport = createCodeTransport(endpoint);
    const pending = transport.eval(
        { source: "while (true) {}" },
        { signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error("user cancelled")), 10);
    await assert.rejects(pending);
    assert.equal(cancelled, true);
});
