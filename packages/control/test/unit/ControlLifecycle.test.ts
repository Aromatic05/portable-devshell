import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FrameReader, FrameWriter, type JsonValue } from "@portable-devshell/shared";

import { ControlLifecycleManager } from "../../dist/control/ControlLifecycleManager.js";
import { ControlConfigTomlCodec, ControlInstanceTomlCodec } from "../../dist/control/config/ControlConfigTomlCodec.js";
import { ControlPathHome } from "../../dist/control/path/ControlPathHome.js";
import { ControlPathRuntime } from "../../dist/control/path/ControlPathRuntime.js";

test("start creates control directory, socket, pid and status uses rpc", async (t) => {
    const harness = await createHarness();
    t.after(() => harness.cleanup());

    const status = await harness.manager.start();

    assert.equal(status.running, true);
    assert.equal(status.instanceCount, 0);
    assert.notEqual(status.pid, undefined);
    await assertPathExists(harness.paths.controlHomeDir);
    await assertPathExists(harness.paths.socketFile);
    await assertPathExists(join(harness.paths.controlHomeDir, "control.pid"));

    const refreshed = await harness.manager.status();
    assert.equal(refreshed.running, true);
    assert.equal(refreshed.instanceCount, 0);
});

test("logs reads control.log", async (t) => {
    const harness = await createHarness();
    t.after(() => harness.cleanup());

    await harness.manager.start();
    const logs = await waitFor(async () => {
        const output = await harness.manager.logs();
        return output.includes("control server started") ? output : undefined;
    });

    assert.match(logs, /control server started/u);
});

test("repeat start does not create another control server", async (t) => {
    const harness = await createHarness();
    t.after(() => harness.cleanup());

    const started = await harness.manager.start();
    const repeated = await harness.manager.start();

    assert.equal(started.running, true);
    assert.equal(repeated.running, true);
    assert.equal(repeated.pid, started.pid);
});

test("stale pid does not mark control as running and start replaces it", async (t) => {
    const harness = await createHarness();
    t.after(() => harness.cleanup());

    await mkdir(harness.paths.controlHomeDir, { recursive: true });
    await writeFile(join(harness.paths.controlHomeDir, "control.pid"), "999999\n", "utf8");

    const beforeStart = await harness.manager.status();
    assert.equal(beforeStart.running, false);
    assert.equal(beforeStart.pid, 999999);

    const started = await harness.manager.start();
    assert.equal(started.running, true);
    assert.notEqual(started.pid, 999999);
});

test("start failure includes recent control log output", async () => {
    const manager = new ControlLifecycleManager({
        logger: {
            error: async () => undefined,
            info: async () => undefined,
            path: "/tmp/control.log",
            readAll: async () => "[2026-07-09T00:00:00.000Z] ERROR control server failed to start\nControlError: invalid config"
        },
        pidFile: {
            read: async () => undefined,
            remove: async () => undefined,
            write: async () => undefined,
            path: "/tmp/control.pid"
        },
        rpcClient: {
            async request() {
                throw new Error("offline");
            }
        },
        socketFile: {
            ensureRuntimeDir: async () => undefined,
            path: "/tmp/control.sock",
            remove: async () => undefined,
            runtimeDir: "/tmp"
        },
        spawnFunction() {
            return { unref() {} } as never;
        },
        waitTimeoutMs: 25
    });

    await assert.rejects(
        manager.start(),
        /control server did not become ready\ncontrol log:\n\[2026-07-09T00:00:00.000Z\] ERROR control server failed to start\nControlError: invalid config/u
    );
});

test("stop sends control.shutdown over rpc", async () => {
    const methods: string[] = [];
    let running = true;
    const manager = new ControlLifecycleManager({
        pidFile: {
            read: async () => 123,
            remove: async () => undefined,
            write: async () => undefined,
            path: "/tmp/control.pid"
        },
        rpcClient: {
            async request(method: string) {
                methods.push(method);

                if (method === "control.status") {
                    if (!running) {
                        throw new Error("offline");
                    }

                    return { instanceCount: 1 };
                }

                running = false;
                return { accepted: true };
            }
        },
        socketFile: {
            ensureRuntimeDir: async () => undefined,
            path: "/tmp/control.sock",
            remove: async () => undefined,
            runtimeDir: "/tmp"
        },
        waitTimeoutMs: 100
    });

    const stopped = await manager.stop();

    assert.deepEqual(methods, ["control.status", "control.shutdown", "control.status", "control.status"]);
    assert.equal(stopped.running, false);
});

test("stop tolerates shutdown socket races in the real lifecycle rpc client", async (t) => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "portable-devshell-control-stop-race-"));
    const runtimePaths = new ControlPathRuntime(runtimeRoot);
    let shutdownRequested = false;
    const server = createServer((socket) => {
        if (shutdownRequested) {
            socket.destroy();
            return;
        }

        const reader = new FrameReader();
        const writer = new FrameWriter(socket);

        socket.on("data", (chunk: Uint8Array) => {
            for (const frame of reader.push(chunk)) {
                const envelope = frame as Record<string, any>;

                if (envelope.method === "control.status") {
                    void writer.write({
                        id: envelope.id,
                        ok: true,
                        result: { instanceCount: 1 },
                        type: "response"
                    } as unknown as JsonValue);
                    continue;
                }

                if (envelope.method === "control.shutdown") {
                    shutdownRequested = true;
                    socket.destroy();
                }
            }
        });
    });

    await mkdir(runtimePaths.runtimeDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(runtimePaths.socketFile, resolve);
    });

    t.after(async () => {
        server.close();
        await rm(runtimeRoot, { force: true, recursive: true });
    });

    const manager = new ControlLifecycleManager({
        pidFile: {
            read: async () => 123,
            remove: async () => undefined,
            write: async () => undefined,
            path: "/tmp/control.pid"
        },
        socketFile: {
            ensureRuntimeDir: async () => undefined,
            path: runtimePaths.socketFile,
            remove: async () => undefined,
            runtimeDir: runtimePaths.runtimeDir
        },
        waitTimeoutMs: 500
    });

    const stopped = await manager.stop();

    assert.equal(shutdownRequested, true);
    assert.equal(stopped.running, false);
});

test("start keeps real worker config registered and does not auto-start worker", async (t) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-control-real-home-"));
    const xdgRuntimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-control-real-runtime-"));
    const homePaths = new ControlPathHome(homeDirectory);
    const runtimePaths = new ControlPathRuntime(xdgRuntimeDir);
    const manager = new ControlLifecycleManager({
        homeDirectory,
        xdgRuntimeDir,
        waitTimeoutMs: 10_000
    });
    const fixturePath = fileURLToPath(new URL("../fixtures/config-valid.toml", import.meta.url));
    const listenPort = await reserveTcpPort();

    await mkdir(homePaths.controlHomeDir, { recursive: true });
    await writeFile(
        homePaths.configFile,
        (await readFile(fixturePath, "utf8")).replace('listenPort = 17890', `listenPort = ${listenPort}`),
        "utf8"
    );
    await mkdir(homePaths.instancesDir, { recursive: true });
    await writeFile(
        homePaths.instanceConfigFile("demo-local"),
        new ControlInstanceTomlCodec().encode({
            enabled: true,
            mcp: {
                allowTools: ["bash_run"],
                enabled: true
            },
            name: "demo-local",
            provider: "local",
            workspace: "/tmp/demo"
        }),
        "utf8"
    );

    t.after(async () => {
        await manager.stop().catch(() => undefined);
        await rm(homeDirectory, { force: true, recursive: true });
        await rm(xdgRuntimeDir, { force: true, recursive: true });
    });

    const started = await manager.start();
    assert.equal(started.running, true);
    assert.equal(started.instanceCount, 1);

    const listed = await request(runtimePaths.socketFile, "control.listInstances");
    assert.equal(Array.isArray(listed), true);
    assert.equal(listed[0]?.name, "demo-local");
    assert.equal(listed[0]?.snapshot.ready, false);
    assert.equal(listed[0]?.snapshot.daemonState, "stopped");
});

async function createHarness(): Promise<{
    cleanup: () => Promise<void>;
    manager: ControlLifecycleManager;
    paths: ControlPathHome & ControlPathRuntime;
}> {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-control-home-"));
    const xdgRuntimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-control-runtime-"));
    const manager = new ControlLifecycleManager({
        homeDirectory,
        xdgRuntimeDir,
        waitTimeoutMs: 10_000
    });
    const homePaths = new ControlPathHome(homeDirectory);
    const runtimePaths = new ControlPathRuntime(xdgRuntimeDir);
    const listenPort = await reserveTcpPort();

    await mkdir(homePaths.controlHomeDir, { recursive: true });
    await writeFile(
        homePaths.configFile,
        new ControlConfigTomlCodec().encode({
            control: {
                logLevel: "info"
            },
            instances: [],
            mcp: {
                auth: {
                    mode: "none"
                },
                enabled: false,
                listenHost: "127.0.0.1",
                listenPort
            },
            version: 1
        }),
        "utf8"
    );

    return {
        async cleanup() {
            await manager.stop().catch(() => undefined);
            await rm(homeDirectory, { force: true, recursive: true });
            await rm(xdgRuntimeDir, { force: true, recursive: true });
        },
        manager,
        paths: {
            ...homePaths,
            ...runtimePaths
        }
    };
}

async function assertPathExists(path: string): Promise<void> {
    await waitFor(async () => {
        try {
            await access(path);
            return true;
        } catch {
            return undefined;
        }
    });
}

async function waitFor<T>(factory: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const value = await factory();

        if (value !== undefined) {
            return value;
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error("Timed out waiting for condition.");
}

async function reserveTcpPort(): Promise<number> {
    const server = createServer();

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();

    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error === undefined) {
                resolve();
                return;
            }

            reject(error);
        });
    });

    if (address === null || typeof address !== "object") {
        throw new Error("Failed to reserve TCP port.");
    }

    return address.port;
}

async function request(socketPath: string, method: string, params?: JsonValue): Promise<any> {
    const socket = createConnection(socketPath);
    const reader = new FrameReader();
    const writer = new FrameWriter(socket);

    await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
    });

    const response = new Promise<any>((resolve, reject) => {
        socket.on("data", (chunk: Uint8Array) => {
            for (const frame of reader.push(chunk)) {
                const envelope = frame as Record<string, any>;

                if (envelope.type !== "response") {
                    continue;
                }

                socket.destroy();

                if (envelope.ok !== true) {
                    reject(new Error(envelope.error?.message ?? "request failed"));
                    return;
                }

                resolve(envelope.result);
            }
        });
        socket.once("error", reject);
    });

    await writer.write({
        id: `${method}-${Date.now()}`,
        issuedAt: new Date().toISOString(),
        method,
        params,
        target: { kind: "control" },
        type: "request"
    } as unknown as JsonValue);

    return await response;
}
