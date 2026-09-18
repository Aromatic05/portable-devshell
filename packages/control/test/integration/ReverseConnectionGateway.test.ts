import assert from "node:assert/strict";

import { join } from "node:path";
import test from "node:test";

import {
    WorkerInstanceFactory,
    WorkerTransportConnection,
    decodeWorkerRpcMessage,
    encodeWorkerRpcMessage,
} from "@portable-devshell/core/testing";
import { HttpHost } from "@portable-devshell/mcp/testing";
import {
    asInstanceName,
    type Channel,
    type JsonValue,
} from "@portable-devshell/shared";
import {
    encodePacket,
    FrameProtocol,
    PacketBuffer,
} from "@portable-devshell/shared/transport/frame";
import WebSocket from "ws";

import {
    GoalService,
    InstanceRegistry,
    ReverseConnectionGateway,
    ReverseCredentialService,
    ReverseCredentialStore,
    TodoService,
} from "../../src/testing.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("WSS reverse connection authenticates, handshakes, and a higher generation replaces the old channel", async () => {
    const home = await createTestTempDirectory("devshell-reverse-gateway");
    const connection = new WorkerTransportConnection();
    const worker = new WorkerInstanceFactory().create({
        homeDirectory: home,
        managementMode: "selfManaged",
        name: asInstanceName("reverse-test"),
        transportConnection: connection,
    });
    const todo = new TodoService({
        appendEvent: async () => undefined,
        filePath: join(home, "todo.json"),
        instanceName: "reverse-test",
    });
    const goal = new GoalService({
        appendEvent: async () => undefined,
        filePath: join(home, "goals.json"),
        instanceName: "reverse-test",
    });
    const registry = new InstanceRegistry([
        {
            enabled: true,
            mcpEnabled: true,
            mcpPath: "/reverse-test/mcp",
            modelExtensions: ["instance"],
            name: "reverse-test",
            provider: "reverse",
            reverseConnection: connection,
            goal,
            todo,
            worker,
        },
    ]);
    const credentialStore = new ReverseCredentialStore(home);
    const server = new HttpHost({
        listenHost: "127.0.0.1",
        listenPort: 0,
        publicBaseUrl: "http://127.0.0.1/base",
    });
    const gateway = new ReverseConnectionGateway({
        credentialStore,
        instanceRegistry: registry,
        publicBaseUrl: "http://127.0.0.1/base",
    });
    gateway.install(server);
    await server.start();

    try {
        const address = server.address;
        assert.equal(typeof address, "object");
        assert.notEqual(address, null);
        const port = (address as { port: number }).port;
        const code = await credentialStore.createDeviceCode("reverse-test");
        const enrollmentResponse = await fetch(
            `http://127.0.0.1:${port}/base/reverse/v1/enroll`,
            {
                body: JSON.stringify({
                    arch: "x64",
                    deviceCode: code.deviceCode,
                    os: "test",
                    workerVersion: "test",
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
            },
        );
        assert.equal(enrollmentResponse.status, 200);
        const enrollment = (await enrollmentResponse.json()) as {
            deviceToken: string;
        };

        const first = connectWorker(port, enrollment.deviceToken, 1);
        await first.opened;
        await Promise.race([
            waitUntil(
                () => worker.snapshot().ready === true,
                () =>
                    JSON.stringify({
                        snapshot: worker.snapshot(),
                        methods: first.methods,
                        errors: first.errors,
                    }),
            ),
            first.closed.then(({ code, reason }) => {
                throw new Error(
                    `First reverse websocket closed during handshake: ${code} ${reason}`,
                );
            }),
        ]);
        assert.equal(worker.snapshot().reverse?.transport, "wss");
        assert.equal(worker.snapshot().reverse?.generation, 1);

        const firstClosed = first.closed;
        const second = connectWorker(port, enrollment.deviceToken, 2);
        await second.opened;
        await waitUntil(
            () =>
                worker.snapshot().reverse?.generation === 2 &&
                worker.snapshot().ready === true,
            () => JSON.stringify(worker.snapshot()),
        );
        await firstClosed;
        assert.equal(worker.snapshot().reverse?.transport, "wss");

        const reverseControl = new ReverseCredentialService({
            credentialStore,
            instanceRegistry: registry,
            publicBaseUrl: "http://127.0.0.1/base",
        });
        reverseControl.setDisconnectHandler((instance) =>
            gateway.disconnect(instance),
        );
        const secondClosed = second.closed;
        const rotated = await reverseControl.rotateDeviceToken("reverse-test");
        assert.notEqual(rotated.deviceToken, enrollment.deviceToken);
        assert.equal(
            await credentialStore.authenticate(
                "reverse-test",
                enrollment.deviceToken,
            ),
            false,
        );
        assert.equal(
            await credentialStore.authenticate(
                "reverse-test",
                rotated.deviceToken,
            ),
            true,
        );
        await secondClosed;
        await waitUntil(
            () => worker.snapshot().reverse?.availability === "offline",
            () => JSON.stringify(worker.snapshot()),
        );
    } finally {
        gateway.stop();
        await server.stop();
    }
});

test("SSE plus POST fallback completes RPC handshake and deduplicates repeated upstream frames", async () => {
    const home = await createTestTempDirectory("devshell-reverse-sse");
    const connection = new WorkerTransportConnection();
    const worker = new WorkerInstanceFactory().create({
        homeDirectory: home,
        managementMode: "selfManaged",
        name: asInstanceName("reverse-test"),
        transportConnection: connection,
    });
    const registry = new InstanceRegistry([
        {
            enabled: true,
            mcpEnabled: true,
            mcpPath: "/reverse-test/mcp",
            modelExtensions: ["instance"],
            name: "reverse-test",
            provider: "reverse",
            reverseConnection: connection,
            goal: new GoalService({
                appendEvent: async () => undefined,
                filePath: join(home, "goals.json"),
                instanceName: "reverse-test",
            }),
            todo: new TodoService({
                appendEvent: async () => undefined,
                filePath: join(home, "todo.json"),
                instanceName: "reverse-test",
            }),
            worker,
        },
    ]);
    const credentialStore = new ReverseCredentialStore(home);
    const server = new HttpHost({
        listenHost: "127.0.0.1",
        listenPort: 0,
        publicBaseUrl: "http://127.0.0.1/base",
    });
    const gateway = new ReverseConnectionGateway({
        credentialStore,
        instanceRegistry: registry,
        publicBaseUrl: "http://127.0.0.1/base",
    });
    gateway.install(server);
    await server.start();

    try {
        const address = server.address;
        assert.equal(typeof address, "object");
        assert.notEqual(address, null);
        const port = (address as { port: number }).port;
        const code = await credentialStore.createDeviceCode("reverse-test");
        const enrollmentResponse = await fetch(
            `http://127.0.0.1:${port}/base/reverse/v1/enroll`,
            {
                body: JSON.stringify({
                    arch: "x64",
                    deviceCode: code.deviceCode,
                    os: "test",
                    workerVersion: "test",
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
            },
        );
        assert.equal(enrollmentResponse.status, 200);
        const enrollment = (await enrollmentResponse.json()) as {
            deviceToken: string;
        };
        const headers = {
            Authorization: `Bearer ${enrollment.deviceToken}`,
            "X-Devshell-Generation": "1",
            "X-Devshell-Instance": "reverse-test",
        };
        const sseResponse = await fetch(
            `http://127.0.0.1:${port}/base/reverse/v1/events`,
            {
                headers,
            },
        );
        assert.equal(sseResponse.status, 200);
        assert.ok(sseResponse.body);
        const reader = sseResponse.body.getReader();
        const methods: string[] = [];
        let upstreamSeq = 0;
        let buffered = "";
        const sseChannel = new TestWorkerChannel(
            async (data) => {
                upstreamSeq += 1;
                const body = {
                    frames: [
                        {
                            frame: Buffer.from(data).toString("base64"),
                            seq: upstreamSeq,
                        },
                    ],
                    generation: 1,
                };
                const post = async () => {
                    const upload = await fetch(
                        `http://127.0.0.1:${port}/base/reverse/v1/frames`,
                        {
                            body: JSON.stringify(body),
                            headers: {
                                ...headers,
                                "content-type": "application/json",
                            },
                            method: "POST",
                        },
                    );
                    assert.equal(upload.status, 200);
                    assert.deepEqual(await upload.json(), {
                        acceptedThrough: upstreamSeq,
                        generation: 1,
                    });
                };
                await post();
                if (upstreamSeq === 1) await post();
            },
            () => undefined,
        );
        void serveWorkerRpc(sseChannel, methods).catch((error: unknown) => {
            sseChannel.finish(
                error instanceof Error ? error : new Error(String(error)),
            );
        });

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
                sseChannel.emit(
                    Buffer.from(dataLine.slice(5).trim(), "base64"),
                );
            }
        }

        await waitUntil(
            () => worker.snapshot().ready === true,
            () => JSON.stringify({ methods, snapshot: worker.snapshot() }),
        );
        assert.deepEqual(methods, [
            "worker.ping",
            "worker.handshake",
            "tools.list",
        ]);
        assert.equal(worker.snapshot().reverse?.transport, "sse");
        await reader.cancel();
        sseChannel.finish();
        await waitUntil(
            () => worker.snapshot().reverse?.availability === "offline",
            () => JSON.stringify(worker.snapshot()),
        );
    } finally {
        gateway.stop();
        await server.stop();
    }
});

function connectWorker(
    port: number,
    token: string,
    generation: number,
): {
    closed: Promise<{ code: number; reason: string }>;
    errors: string[];
    methods: string[];
    opened: Promise<void>;
    socket: WebSocket;
} {
    const methods: string[] = [];
    const errors: string[] = [];
    const socket = new WebSocket(
        `ws://127.0.0.1:${port}/base/reverse/v1/connect`,
        "devshell-worker-transport.v1",
        {
            headers: {
                Authorization: `Bearer ${token}`,
                "X-Devshell-Generation": String(generation),
                "X-Devshell-Instance": "reverse-test",
            },
        },
    );
    const channel = new TestWorkerChannel(
        async (data) =>
            await new Promise<void>((resolve, reject) => {
                socket.send(data, { binary: true }, (error) =>
                    error == null ? resolve() : reject(error),
                );
            }),
        () => socket.close(1000, "worker closed"),
    );
    void serveWorkerRpc(channel, methods).catch((error: unknown) => {
        errors.push(error instanceof Error ? error.message : String(error));
    });
    socket.on("message", (data, isBinary) => {
        assert.equal(isBinary, true);
        channel.emit(
            Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer),
        );
    });
    socket.on("error", (error) => {
        errors.push(error.message);
        channel.finish(error);
    });
    socket.once("close", (code, reason) => {
        channel.finish(
            code === 1000
                ? undefined
                : new Error(`WebSocket closed: ${code} ${reason.toString()}`),
        );
    });
    return {
        closed: new Promise((resolve) =>
            socket.once("close", (code, reason) =>
                resolve({ code, reason: reason.toString() }),
            ),
        ),
        errors,
        methods,
        opened: new Promise((resolve, reject) => {
            socket.once("open", () => resolve());
            socket.once("error", reject);
        }),
        socket,
    };
}

class TestWorkerChannel implements Channel {
    readonly #dataListeners = new Set<(data: Uint8Array) => void>();
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #send: (data: Uint8Array) => Promise<void>;
    readonly #closeTransport: () => void;
    #closed = false;
    #writeTail: Promise<void> = Promise.resolve();

    constructor(
        send: (data: Uint8Array) => Promise<void>,
        closeTransport: () => void,
    ) {
        this.#send = send;
        this.#closeTransport = closeTransport;
    }

    get closed(): boolean {
        return this.#closed;
    }

    write(data: Uint8Array): Promise<void> {
        if (this.#closed) return Promise.reject(new Error("worker channel is closed"));
        const copy = Uint8Array.from(data);
        const write = this.#writeTail.then(() => this.#send(copy));
        this.#writeTail = write.catch(() => undefined);
        return write;
    }

    onData(listener: (data: Uint8Array) => void): () => void {
        this.#dataListeners.add(listener);
        return () => this.#dataListeners.delete(listener);
    }

    onClose(listener: (error?: Error) => void): () => void {
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    close(error?: Error): void {
        if (this.#closed) return;
        this.#closeTransport();
        this.finish(error);
    }

    emit(data: Uint8Array): void {
        if (this.#closed) return;
        for (const listener of [...this.#dataListeners]) listener(Uint8Array.from(data));
    }

    finish(error?: Error): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const listener of [...this.#closeListeners]) listener(error);
        this.#dataListeners.clear();
        this.#closeListeners.clear();
    }
}

async function serveWorkerRpc(
    channel: Channel,
    methods: string[],
): Promise<void> {
    const protocol = new FrameProtocol(channel, { role: "acceptor" });
    const open = await protocol.nextOpen();
    assert.notEqual(open, undefined);
    assert.equal(open!.service, "worker.rpc");
    assert.equal(open!.metadata.byteLength, 0);
    const stream = await open!.accept();
    const packets = new PacketBuffer();
    while (true) {
        const chunk = await stream.read();
        if (chunk === undefined) return;
        for (const payload of packets.push(chunk)) {
            const request = decodeWorkerRpcMessage(payload) as Record<string, JsonValue>;
            const id = String(request.id);
            const method = String(request.method);
            methods.push(method);
            await stream.write(
                encodePacket(
                    encodeWorkerRpcMessage({
                        id,
                        ok: true,
                        result: responseFor(method),
                        type: "response",
                    }),
                ),
            );
        }
    }
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
                workspace: "/workspace",
            };
        case "tools.list":
            return { tools: [] };
        case "worker.stop":
            return { stopping: true };
        default:
            throw new Error(`Unexpected worker method: ${method}`);
    }
}
async function waitUntil(
    predicate: () => boolean,
    describe: () => string = () => "condition was not reached",
): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Condition was not reached: ${describe()}`);
}
