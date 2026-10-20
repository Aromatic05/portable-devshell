import assert from "node:assert/strict";

import { join } from "node:path";
import test from "node:test";

import { HttpHost } from "@portable-devshell/mcp/testing";
import {
    Endpoint,
    Rpc,
    WORKER_PROTOCOL_VERSION,
    asInstanceName,
    normalizeConfigInstanceDraft,
    type Channel,
    type JsonValue,
} from "@portable-devshell/shared";
import WebSocket from "ws";

import { Instance } from "@portable-devshell/core/instance";
import { ReverseConnections } from "@portable-devshell/core";
import { InstanceRegistry } from "../../src/instance/Registry.ts";
import { ReverseCredentials } from "../../src/instance/reverse/Credentials.ts";
import { ReverseCredentialStore } from "../../src/instance/reverse/credential/Store.ts";
import { ReverseIngress } from "../../src/server/reverse/Ingress.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("WSS reverse connection authenticates, handshakes, and a higher generation replaces the old channel", async () => {
    const home = await createTestTempDirectory("devshell-reverse-gateway");
    const instance = Instance.create(
        normalizeConfigInstanceDraft({
            enabled: true,
            name: "reverse-test",
            provider: "reverse",
        }),
    );
    const registry = new InstanceRegistry([instance]);
    const credentialStore = new ReverseCredentialStore(home);
    const server = new HttpHost({
        listenHost: "127.0.0.1",
        listenPort: 0,
        publicBaseUrl: "http://127.0.0.1/base",
    });
    const connections = new ReverseConnections({ instances: registry });
    const credentials = new ReverseCredentials({
        credentialStore,
        instanceRegistry: registry,
        publicBaseUrl: "http://127.0.0.1/base",
    });
    const ingress = new ReverseIngress({
        connections,
        credentials,
        publicBaseUrl: "http://127.0.0.1/base",
    });
    ingress.install(server);
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
                () => instance.supervision.snapshot().ready === true,
                () =>
                    JSON.stringify({
                        snapshot: instance.supervision.snapshot(),
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
        assert.equal(instance.supervision.snapshot().reverse?.transport, "wss");
        assert.equal(instance.supervision.snapshot().reverse?.generation, 1);

        const firstClosed = first.closed;
        const second = connectWorker(port, enrollment.deviceToken, 2, "v2");
        await second.opened;
        await waitUntil(
            () =>
                instance.supervision.snapshot().reverse?.generation === 2 &&
                instance.supervision.snapshot().ready === true,
            () => JSON.stringify(instance.supervision.snapshot()),
        );
        await firstClosed;
        assert.equal(instance.supervision.snapshot().reverse?.transport, "wss");
        assert.ok(second.acks.length > 0, "WSS v2 replies must receive frame ACKs");

        const reverseControl = credentials;
        reverseControl.setDisconnectHandler((instanceName) =>
            connections.disconnect(instanceName),
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
            () => instance.supervision.snapshot().reverse?.availability === "offline",
            () => JSON.stringify(instance.supervision.snapshot()),
        );

        // A new Device Code can retain its predecessor until authentication,
        // permitting a replacement Worker to restart generation 2 at 1.
        const replacementCode = await credentialStore.createDeviceCode("reverse-test");
        const replacement = await credentialStore.consumeDeviceCode(replacementCode.deviceCode);
        const restarted = connectWorker(port, replacement.deviceToken, 1, "v2");
        await restarted.opened;
        await waitUntil(
            () =>
                instance.supervision.snapshot().reverse?.generation === 1 &&
                instance.supervision.snapshot().ready === true,
            () => JSON.stringify({
                snapshot: instance.supervision.snapshot(),
                methods: restarted.methods,
                errors: restarted.errors,
            }),
        );
        // Instance snapshot readiness becomes visible at the activation step,
        // *before* credential rollover is atomically committed. The explicit
        // DSR2:ready WSS frame is sent only after the predecessor is revoked.
        // Do not turn a valid in-flight predecessor token into a flaky failure.
        await waitUntil(
            () => restarted.acks.includes("ready"),
            () => JSON.stringify({ acks: restarted.acks, methods: restarted.methods,
                snapshot: instance.supervision.snapshot() }),
        );
        assert.equal(await credentialStore.authenticate("reverse-test", rotated.deviceToken), false);
        connections.disconnect("reverse-test");
        await restarted.closed;
    } finally {
        ingress.stop();
        await server.stop();
    }
});

test("SSE plus POST fallback completes RPC handshake and deduplicates repeated upstream frames", async () => {
    const home = await createTestTempDirectory("devshell-reverse-sse");
    const instance = Instance.create(
        normalizeConfigInstanceDraft({
            enabled: true,
            name: "reverse-test",
            provider: "reverse",
        }),
    );
    const registry = new InstanceRegistry([instance]);
    const credentialStore = new ReverseCredentialStore(home);
    const server = new HttpHost({
        listenHost: "127.0.0.1",
        listenPort: 0,
        publicBaseUrl: "http://127.0.0.1/base",
    });
    const connections = new ReverseConnections({ instances: registry });
    const credentials = new ReverseCredentials({
        credentialStore,
        instanceRegistry: registry,
        publicBaseUrl: "http://127.0.0.1/base",
    });
    const ingress = new ReverseIngress({
        connections,
        credentials,
        publicBaseUrl: "http://127.0.0.1/base",
    });
    ingress.install(server);
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
        void serveWorkerEndpoint(sseChannel, methods).catch(
            (error: unknown) => {
                sseChannel.finish(
                    error instanceof Error ? error : new Error(String(error)),
                );
            },
        );

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
            () => instance.supervision.snapshot().ready === true,
            () => JSON.stringify({ methods, snapshot: instance.supervision.snapshot() }),
        );
        assert.deepEqual(methods, [
            "worker.ping",
            "worker.handshake",
            "tools.list",
        ]);
        assert.equal(instance.supervision.snapshot().reverse?.transport, "sse");
        await reader.cancel();
        sseChannel.finish();
        await waitUntil(
            () => instance.supervision.snapshot().reverse?.availability === "offline",
            () => JSON.stringify(instance.supervision.snapshot()),
        );
    } finally {
        ingress.stop();
        await server.stop();
    }
});

function connectWorker(
    port: number,
    token: string,
    generation: number,
    protocol: "v1" | "v2" = "v1",
): {
    acks: string[];
    closed: Promise<{ code: number; reason: string }>;
    errors: string[];
    methods: string[];
    opened: Promise<void>;
    socket: WebSocket;
} {
    const methods: string[] = [];
    const errors: string[] = [];
    const acks: string[] = [];
    let frameSequence = 0n;
    const session = Buffer.alloc(16, generation);
    const socket = new WebSocket(
        `ws://127.0.0.1:${port}/base/reverse/v1/connect`,
        protocol === "v2" ? "devshell-worker-transport.v2" : "devshell-worker-transport.v1",
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
                const frame = protocol === "v2"
                    ? (() => {
                        const header = Buffer.alloc(28);
                        header.write("DSR2", 0, "ascii");
                        session.copy(header, 4);
                        header.writeBigUInt64BE(++frameSequence, 20);
                        return Buffer.concat([header, Buffer.from(data)]);
                    })()
                    : data;
                socket.send(frame, { binary: true }, (error) =>
                    error == null ? resolve() : reject(error),
                );
            }),
        () => socket.close(1000, "worker closed"),
    );
    void serveWorkerEndpoint(channel, methods).catch((error: unknown) => {
        errors.push(error instanceof Error ? error.message : String(error));
    });
    socket.on("message", (data, isBinary) => {
        if (!isBinary && protocol === "v2") {
            if (data.toString() === "DSR2:ready") {
                acks.push("ready");
            } else {
                acks.push(data.toString());
            }
            return;
        }
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
        acks,
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
        if (this.#closed)
            return Promise.reject(new Error("worker channel is closed"));
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
        for (const listener of [...this.#dataListeners])
            listener(Uint8Array.from(data));
    }

    finish(error?: Error): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const listener of [...this.#closeListeners]) listener(error);
        this.#dataListeners.clear();
        this.#closeListeners.clear();
    }
}

async function serveWorkerEndpoint(
    channel: Channel,
    methods: string[],
): Promise<void> {
    const endpoint = new Endpoint({ host: "reverse-test-worker" });
    const core = new Rpc(endpoint.bind("core"), {
        "worker.ping": () => {
            methods.push("worker.ping");
            return responseFor("worker.ping");
        },
        "worker.handshake": () => {
            methods.push("worker.handshake");
            return responseFor("worker.handshake");
        },
        "worker.stop": () => {
            methods.push("worker.stop");
            return responseFor("worker.stop");
        },
    });
    const tool = new Rpc(endpoint.bind("tool"), {
        "tools.list": () => {
            methods.push("tools.list");
            return responseFor("tools.list");
        },
    });
    const closed = new Promise<void>((resolve) =>
        channel.onClose(() => resolve()),
    );
    const detach = await endpoint.accept(channel);
    try {
        await closed;
    } finally {
        detach();
        core.close();
        tool.close();
        endpoint.close();
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
                protocolVersion: WORKER_PROTOCOL_VERSION,
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
