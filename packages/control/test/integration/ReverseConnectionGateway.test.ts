import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkerInstanceFactory, WorkerRpcInboundConnector } from "@portable-devshell/core";
import { McpHostHttpServer } from "@portable-devshell/mcp";
import { FrameCodec, asInstanceName, asWorkspacePath, type JsonValue } from "@portable-devshell/shared";
import WebSocket from "ws";

import {
    InstanceRegistry,
    ReverseConnectionGateway,
    ReverseControlService,
    ReverseCredentialStore,
    TodoService
} from "../../dist/index.js";

test("WSS reverse connection authenticates, handshakes, and a higher generation replaces the old channel", async () => {
    const home = await mkdtemp(join(tmpdir(), "devshell-reverse-gateway-"));
    const connector = new WorkerRpcInboundConnector();
    const worker = new WorkerInstanceFactory().create({
        defaultWorkspace: asWorkspacePath(home),
        homeDirectory: home,
        managementMode: "selfManaged",
        name: asInstanceName("reverse-test"),
        rpcConnector: connector
    });
    const todo = new TodoService({
        appendEvent: async () => undefined,
        filePath: join(home, "todo.json"),
        instanceName: "reverse-test"
    });
    const registry = new InstanceRegistry([
        {
            enabled: true,
            mcpCapabilities: ["read", "write", "execute"],
            mcpEnabled: true,
            mcpGroups: ["bash"],
            mcpPath: "/reverse-test/mcp",
            name: "reverse-test",
            provider: "reverse",
            reverseConnector: connector,
            todo,
            worker,
            workspace: home
        }
    ]);
    const credentialStore = new ReverseCredentialStore(home);
    const server = new McpHostHttpServer({
        listenHost: "127.0.0.1",
        listenPort: 0,
        publicBaseUrl: "http://127.0.0.1/base"
    });
    const gateway = new ReverseConnectionGateway({
        credentialStore,
        instanceRegistry: registry,
        publicBaseUrl: "http://127.0.0.1/base"
    });
    gateway.install(server);
    await server.start();

    try {
        const address = server.address;
        assert.equal(typeof address, "object");
        assert.notEqual(address, null);
        const port = (address as { port: number }).port;
        const code = await credentialStore.createDeviceCode("reverse-test");
        const enrollmentResponse = await fetch(`http://127.0.0.1:${port}/base/reverse/v1/enroll`, {
            body: JSON.stringify({
                arch: "x64",
                deviceCode: code.deviceCode,
                os: "test",
                workerVersion: "test"
            }),
            headers: { "content-type": "application/json" },
            method: "POST"
        });
        assert.equal(enrollmentResponse.status, 200);
        const enrollment = (await enrollmentResponse.json()) as { deviceToken: string };

        const first = connectWorker(port, enrollment.deviceToken, 1);
        await first.opened;
        await Promise.race([
            waitUntil(
                () => worker.snapshot().ready === true,
                () => JSON.stringify({ snapshot: worker.snapshot(), methods: first.methods, errors: first.errors })
            ),
            first.closed.then(({ code, reason }) => {
                throw new Error(`First reverse websocket closed during handshake: ${code} ${reason}`);
            })
        ]);
        assert.equal(worker.snapshot().reverse?.transport, "wss");
        assert.equal(worker.snapshot().reverse?.generation, 1);

        const firstClosed = first.closed;
        const second = connectWorker(port, enrollment.deviceToken, 2);
        await second.opened;
        await waitUntil(
            () => worker.snapshot().reverse?.generation === 2 && worker.snapshot().ready === true,
            () => JSON.stringify(worker.snapshot())
        );
        await firstClosed;
        assert.equal(worker.snapshot().reverse?.transport, "wss");

        const reverseControl = new ReverseControlService({
            credentialStore,
            instanceRegistry: registry,
            publicBaseUrl: "http://127.0.0.1/base"
        });
        reverseControl.setDisconnectHandler((instance) => gateway.disconnect(instance));
        const secondClosed = second.closed;
        const rotated = await reverseControl.rotateDeviceToken("reverse-test");
        assert.notEqual(rotated.deviceToken, enrollment.deviceToken);
        assert.equal(await credentialStore.authenticate("reverse-test", enrollment.deviceToken), false);
        assert.equal(await credentialStore.authenticate("reverse-test", rotated.deviceToken), true);
        await secondClosed;
        await waitUntil(
            () => worker.snapshot().reverse?.availability === "offline",
            () => JSON.stringify(worker.snapshot())
        );
    } finally {
        gateway.stop();
        await server.stop();
    }
});

test("SSE plus POST fallback completes RPC handshake and deduplicates repeated upstream frames", async () => {
    const home = await mkdtemp(join(tmpdir(), "devshell-reverse-sse-"));
    const connector = new WorkerRpcInboundConnector();
    const worker = new WorkerInstanceFactory().create({
        defaultWorkspace: asWorkspacePath(home),
        homeDirectory: home,
        managementMode: "selfManaged",
        name: asInstanceName("reverse-test"),
        rpcConnector: connector
    });
    const registry = new InstanceRegistry([
        {
            enabled: true,
            mcpCapabilities: ["read", "write", "execute"],
            mcpEnabled: true,
            mcpGroups: ["bash"],
            mcpPath: "/reverse-test/mcp",
            name: "reverse-test",
            provider: "reverse",
            reverseConnector: connector,
            todo: new TodoService({
                appendEvent: async () => undefined,
                filePath: join(home, "todo.json"),
                instanceName: "reverse-test"
            }),
            worker,
            workspace: home
        }
    ]);
    const credentialStore = new ReverseCredentialStore(home);
    const server = new McpHostHttpServer({
        listenHost: "127.0.0.1",
        listenPort: 0,
        publicBaseUrl: "http://127.0.0.1/base"
    });
    const gateway = new ReverseConnectionGateway({
        credentialStore,
        instanceRegistry: registry,
        publicBaseUrl: "http://127.0.0.1/base"
    });
    gateway.install(server);
    await server.start();

    try {
        const address = server.address;
        assert.equal(typeof address, "object");
        assert.notEqual(address, null);
        const port = (address as { port: number }).port;
        const code = await credentialStore.createDeviceCode("reverse-test");
        const enrollmentResponse = await fetch(`http://127.0.0.1:${port}/base/reverse/v1/enroll`, {
            body: JSON.stringify({
                arch: "x64",
                deviceCode: code.deviceCode,
                os: "test",
                workerVersion: "test"
            }),
            headers: { "content-type": "application/json" },
            method: "POST"
        });
        assert.equal(enrollmentResponse.status, 200);
        const enrollment = (await enrollmentResponse.json()) as { deviceToken: string };
        const headers = {
            Authorization: `Bearer ${enrollment.deviceToken}`,
            "X-Devshell-Generation": "1",
            "X-Devshell-Instance": "reverse-test"
        };
        const sseResponse = await fetch(`http://127.0.0.1:${port}/base/reverse/v1/events`, {
            headers
        });
        assert.equal(sseResponse.status, 200);
        assert.ok(sseResponse.body);
        const reader = sseResponse.body.getReader();
        const methods: string[] = [];
        let upstreamSeq = 0;
        let buffered = "";

        while (methods.length < 3) {
            const chunk = await reader.read();
            assert.equal(chunk.done, false);
            buffered += new TextDecoder().decode(chunk.value, { stream: true });
            let boundary = buffered.indexOf("\n\n");
            while (boundary >= 0) {
                const event = buffered.slice(0, boundary);
                buffered = buffered.slice(boundary + 2);
                boundary = buffered.indexOf("\n\n");
                const dataLine = event
                    .split("\n")
                    .find((line) => line.startsWith("data:"));
                if (dataLine === undefined) {
                    continue;
                }
                const request = FrameCodec.decode(Buffer.from(dataLine.slice(5).trim(), "base64")) as Record<
                    string,
                    JsonValue
                >;
                const method = String(request.method);
                methods.push(method);
                upstreamSeq += 1;
                const body = {
                    frames: [
                        {
                            frame: FrameCodec.encode({
                                id: String(request.id),
                                ok: true,
                                result: responseFor(method),
                                type: "response"
                            }).toString("base64"),
                            seq: upstreamSeq
                        }
                    ],
                    generation: 1
                };
                const upload = await fetch(`http://127.0.0.1:${port}/base/reverse/v1/frames`, {
                    body: JSON.stringify(body),
                    headers: { ...headers, "content-type": "application/json" },
                    method: "POST"
                });
                assert.equal(upload.status, 200);
                if (upstreamSeq === 1) {
                    const duplicate = await fetch(`http://127.0.0.1:${port}/base/reverse/v1/frames`, {
                        body: JSON.stringify(body),
                        headers: { ...headers, "content-type": "application/json" },
                        method: "POST"
                    });
                    assert.equal(duplicate.status, 200);
                    assert.deepEqual(await duplicate.json(), { acceptedThrough: 1, generation: 1 });
                }
            }
        }

        await waitUntil(
            () => worker.snapshot().ready === true,
            () => JSON.stringify({ methods, snapshot: worker.snapshot() })
        );
        assert.deepEqual(methods, ["worker.ping", "worker.handshake", "tools.list"]);
        assert.equal(worker.snapshot().reverse?.transport, "sse");
        await reader.cancel();
        await waitUntil(
            () => worker.snapshot().reverse?.availability === "offline",
            () => JSON.stringify(worker.snapshot())
        );
    } finally {
        gateway.stop();
        await server.stop();
    }
});

function connectWorker(port: number, token: string, generation: number): {
    closed: Promise<{ code: number; reason: string }>;
    errors: string[];
    methods: string[];
    opened: Promise<void>;
    socket: WebSocket;
} {
    const methods: string[] = [];
    const errors: string[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/base/reverse/v1/connect`, "devshell-worker-rpc.v1", {
        headers: {
            Authorization: `Bearer ${token}`,
            "X-Devshell-Generation": String(generation),
            "X-Devshell-Instance": "reverse-test"
        }
    });
    socket.on("message", (data, isBinary) => {
        assert.equal(isBinary, true);
        const request = FrameCodec.decode(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)) as Record<
            string,
            JsonValue
        >;
        const id = String(request.id);
        const method = String(request.method);
        methods.push(method);
        socket.send(FrameCodec.encode({
            id,
            ok: true,
            result: responseFor(method),
            type: "response"
        }));
    });
    socket.on("error", (error) => errors.push(error.message));
    return {
        closed: new Promise((resolve) => socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))),
        errors,
        methods,
        opened: new Promise((resolve, reject) => {
            socket.once("open", () => resolve());
            socket.once("error", reject);
        }),
        socket
    };
}

function responseFor(method: string): JsonValue {
    switch (method) {
        case "worker.ping":
            return { pong: true };
        case "worker.handshake":
            return {
                capabilities: { cancel: true, streaming: false, tools: true },
                instance: "reverse-test",
                platform: { arch: "x64", os: "test" },
                protocolVersion: 2,
                workerVersion: "test",
                workspace: "/workspace"
            };
        case "tools.list":
            return { tools: [] };
        case "worker.stop":
            return { stopping: true };
        default:
            throw new Error(`Unexpected worker method: ${method}`);
    }
}
async function waitUntil(predicate: () => boolean, describe: () => string = () => "condition was not reached"): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Condition was not reached: ${describe()}`);
}