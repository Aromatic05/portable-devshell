import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    ClientConnection,
    Codec,
    createError,
    ControlLifecycleManager,
    ControlPathHome,
    ControlPathRuntime,
    SocketChannel,
    type Event,
    type JsonValue
} from "@portable-devshell/shared";

import { controlDaemonModulePath } from "../../src/testing.ts";
import { createTestIpcPath, installUniqueWindowsTestIdentity } from "../../../../test/TestPlatformSupport.ts";
import { encodeGlobalConfig, encodeInstanceConfig } from "../ConfigTomlTestSupport.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("start creates control directory, socket, pid and status uses rpc", async (t) => {
    const harness = await createHarness();
    t.after(() => harness.cleanup());

    const status = await harness.manager.start();

    assert.equal(status.running, true);
    assert.equal(status.instanceCount, 0);
    assert.notEqual(status.pid, undefined);
    await assertPathExists(harness.paths.controlHomeDir);
    if (process.platform !== "win32") {
        await assertPathExists(harness.paths.socketFile);
    }
    await assertPathExists(join(harness.paths.controlHomeDir, "control.pid"));
    const startupLog = await readFile(join(harness.paths.controlHomeDir, "logs", "control.startup.log"), "utf8");
    assert.match(startupLog, /STARTUP control state load started/u);
    assert.match(startupLog, /STARTUP control runtime composition started/u);
    assert.match(startupLog, /STARTUP control runtime start completed/u);
    assert.match(startupLog, /STARTUP control daemon start completed/u);

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

test("concurrent lifecycle managers create only one control daemon", async (t) => {
    const harness = await createHarness();
    t.after(() => harness.cleanup());
    const second = new ControlLifecycleManager({
        daemonModulePath: controlDaemonModulePath(),
        homeDirectory: harness.homeDirectory,
        xdgRuntimeDir: harness.xdgRuntimeDir,
        waitTimeoutMs: 10_000
    });

    const [firstStatus, secondStatus] = await Promise.all([
        harness.manager.start(),
        second.start()
    ]);

    assert.equal(firstStatus.pid, secondStatus.pid);
    const logs = await harness.manager.logs();
    assert.equal(logs.match(/control server started/gu)?.length, 1);
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

test("start terminates a verified stale Control process before replacing it", async () => {
    let recordedPid: number | undefined = 123;
    let staleRunning = true;
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const manager = new ControlLifecycleManager({
        daemonModulePath: controlDaemonModulePath(),
        pidFile: {
            read: async () => recordedPid,
            remove: async () => { recordedPid = undefined; },
            write: async (pid) => { recordedPid = pid; },
            path: "/tmp/control.pid"
        },
        processIdentity: async (pid) => pid === 123 ? "control" : "unknown",
        processIsRunning: (pid) => pid === 123 ? staleRunning : pid === 456,
        rpcClient: {
            async request() {
                if (recordedPid === 456) return { instanceCount: 0, pid: 456 };
                throw new Error("offline");
            }
        },
        signalProcess(pid, signal) {
            signals.push({ pid, signal });
            if (pid === 123) staleRunning = false;
        },
        socketFile: {
            ensureRuntimeDir: async () => undefined,
            path: "/tmp/control.sock",
            remove: async () => undefined,
            runtimeDir: "/tmp"
        },
        spawnFunction() {
            return { pid: 456, unref() {} } as never;
        },
        waitTimeoutMs: 100
    });

    const started = await manager.start();

    assert.equal(started.running, true);
    assert.equal(started.pid, 456);
    assert.deepEqual(signals, [{ pid: 123, signal: "SIGTERM" }]);
});

test("start replaces stale metadata without signalling a verified unrelated process", async () => {
    let recordedPid: number | undefined = 123;
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const manager = new ControlLifecycleManager({
        daemonModulePath: controlDaemonModulePath(),
        pidFile: {
            read: async () => recordedPid,
            remove: async () => { recordedPid = undefined; },
            write: async (pid) => { recordedPid = pid; },
            path: "/tmp/control.pid"
        },
        processIdentity: async (pid) => pid === 123 ? "other" : "unknown",
        processIsRunning: (pid) => pid === 123 || pid === 456,
        rpcClient: {
            async request() {
                if (recordedPid === 456) return { instanceCount: 0, pid: 456 };
                throw new Error("offline");
            }
        },
        signalProcess(pid, signal) {
            signals.push({ pid, signal });
        },
        socketFile: {
            ensureRuntimeDir: async () => undefined,
            path: "/tmp/control.sock",
            remove: async () => undefined,
            runtimeDir: "/tmp"
        },
        spawnFunction() {
            return { pid: 456, unref() {} } as never;
        },
        waitTimeoutMs: 100
    });

    const started = await manager.start();

    assert.equal(started.running, true);
    assert.equal(started.pid, 456);
    assert.deepEqual(signals, []);
});

test("start still refuses a live pid whose process identity is unknown", async () => {
    const manager = new ControlLifecycleManager({
        daemonModulePath: controlDaemonModulePath(),
        pidFile: {
            read: async () => 123,
            remove: async () => undefined,
            write: async () => undefined,
            path: "/tmp/control.pid"
        },
        processIdentity: async () => "unknown",
        processIsRunning: () => true,
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
        waitTimeoutMs: 50
    });

    await assert.rejects(manager.start(), /process identity could not be verified/u);
});

test(
    "Linux process identity recognizes and stops a matching detached Control command",
    { skip: process.platform === "linux" ? false : "requires Linux /proc process identity" },
    async (t) => {
        const root = await createTestTempDirectory("control-process-identity");
        const homeDirectory = join(root, "home");
        const xdgRuntimeDir = join(root, "runtime");
        const daemonModulePath = join(root, "ControlDaemon.mjs");
        await mkdir(homeDirectory, { recursive: true });
        await mkdir(xdgRuntimeDir, { recursive: true });
        await writeFile(daemonModulePath, "setInterval(() => {}, 1000);\n", "utf8");
        const child = spawn(process.execPath, [daemonModulePath], {
            detached: true,
            env: {
                ...process.env,
                HOME: homeDirectory,
                XDG_RUNTIME_DIR: xdgRuntimeDir
            },
            stdio: "ignore"
        });
        const pid = child.pid;
        assert.notEqual(pid, undefined);
        child.unref();
        t.after(async () => {
            if (pid !== undefined && isProcessRunning(pid)) process.kill(pid, "SIGKILL");
            await rm(root, { force: true, recursive: true });
        });

        let recordedPid = pid;
        const manager = new ControlLifecycleManager({
            daemonModulePath,
            homeDirectory,
            pidFile: {
                read: async () => recordedPid,
                remove: async () => { recordedPid = undefined; },
                write: async (nextPid) => { recordedPid = nextPid; },
                path: join(homeDirectory, "control.pid")
            },
            rpcClient: {
                async request() {
                    throw new Error("offline");
                }
            },
            socketFile: {
                ensureRuntimeDir: async () => undefined,
                path: join(xdgRuntimeDir, "control.sock"),
                remove: async () => undefined,
                runtimeDir: xdgRuntimeDir
            },
            waitTimeoutMs: 1_000,
            xdgRuntimeDir
        });

        const stopped = await manager.stop();

        assert.equal(stopped.running, false);
        assert.equal(recordedPid, undefined);
        await waitFor(async () => isProcessRunning(pid!) ? undefined : true, 3_000);
    }
);

test("start failure reports only the current startup attempt", async () => {
    const root = await createTestTempDirectory("control-startup-attempt");
    const startupLogPath = join(root, "control.startup.log");
    try {
        const manager = new ControlLifecycleManager({
            daemonModulePath: controlDaemonModulePath(),
            logger: {
                error: async () => undefined,
                info: async () => undefined,
                path: join(root, "control.log"),
                readAll: async () => "stale historical failure"
            },
            pidFile: {
                read: async () => undefined,
                remove: async () => undefined,
                write: async () => undefined,
                path: join(root, "control.pid")
            },
            processIsRunning: (pid) => pid === 424_242,
            rpcClient: {
                async request() {
                    throw new Error("offline");
                }
            },
            socketFile: {
                ensureRuntimeDir: async () => undefined,
                path: join(root, "control.sock"),
                remove: async () => undefined,
                runtimeDir: root
            },
            spawnFunction(_command, _args, options) {
                const stdio = options.stdio as [unknown, number, number];
                writeSync(stdio[2], "current startup failure\n");
                return { pid: 424_242, unref() {} } as never;
            },
            startupLogPath,
            waitTimeoutMs: 25
        });

        await assert.rejects(manager.start(), (error: unknown) => {
            assert.match(String(error), /control server did not become ready/u);
            assert.match(String(error), /current startup failure/u);
            assert.doesNotMatch(String(error), /stale historical failure/u);
            return true;
        });
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("pid publication failure terminates the spawned control process", async (t) => {
    const root = await createTestTempDirectory("control-pid-failure");
    let childPid: number | undefined;
    t.after(async () => {
        if (childPid !== undefined && isProcessRunning(childPid)) {
            process.kill(childPid, "SIGKILL");
        }
        await rm(root, { force: true, recursive: true });
    });
    const manager = new ControlLifecycleManager({
        daemonModulePath: controlDaemonModulePath(),
        logger: {
            error: async () => undefined,
            info: async () => undefined,
            path: join(root, "control.log"),
            readAll: async () => ""
        },
        pidFile: {
            read: async () => undefined,
            remove: async () => undefined,
            async write() {
                throw new Error("pid write failed");
            },
            path: join(root, "control.pid")
        },
        rpcClient: {
            async request() {
                throw new Error("offline");
            }
        },
        socketFile: {
            ensureRuntimeDir: async () => undefined,
            path: join(root, "control.sock"),
            remove: async () => undefined,
            runtimeDir: root
        },
        spawnFunction() {
            const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
                detached: true,
                stdio: "ignore"
            });
            childPid = child.pid;
            return child;
        },
        waitTimeoutMs: 500
    });

    await assert.rejects(manager.start(), /pid write failed/u);
    assert.notEqual(childPid, undefined);
    await waitFor(async () => isProcessRunning(childPid!) ? undefined : true, 3_000);
});

test("stop sends control.shutdown over rpc", async () => {
    const methods: string[] = [];
    let running = true;
    const manager = new ControlLifecycleManager({
        daemonModulePath: controlDaemonModulePath(),
        pidFile: {
            read: async () => 123,
            remove: async () => undefined,
            write: async () => undefined,
            path: "/tmp/control.pid"
        },
        processIsRunning: () => false,
        rpcClient: {
            async request(method: "status" | "shutdown"): Promise<JsonValue> {
                methods.push(method);

                if (method === "status") {
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

    assert.deepEqual(methods, ["status", "shutdown", "status", "status"]);
    assert.equal(stopped.running, false);
});

test("stop waits for the daemon process after the control socket closes", async () => {
    let rpcRunning = true;
    let shutdownRequested = false;
    let processChecksAfterShutdown = 0;
    const manager = new ControlLifecycleManager({
        daemonModulePath: controlDaemonModulePath(),
        pidFile: {
            read: async () => 123,
            remove: async () => undefined,
            write: async () => undefined,
            path: "/tmp/control.pid"
        },
        processIsRunning: () => {
            if (!shutdownRequested) return true;
            processChecksAfterShutdown += 1;
            return processChecksAfterShutdown < 2;
        },
        rpcClient: {
            async request(method: "status" | "shutdown"): Promise<JsonValue> {
                if (method === "shutdown") {
                    shutdownRequested = true;
                    rpcRunning = false;
                    return { accepted: true };
                }
                if (!rpcRunning) {
                    throw new Error("offline");
                }
                return { instanceCount: 1 };
            }
        },
        socketFile: {
            ensureRuntimeDir: async () => undefined,
            path: "/tmp/control.sock",
            remove: async () => undefined,
            runtimeDir: "/tmp"
        },
        waitTimeoutMs: 500
    });

    const stopped = await manager.stop();
    assert.equal(shutdownRequested, true);
    assert.equal(processChecksAfterShutdown >= 2, true);
    assert.equal(stopped.running, false);
});

test("stop refuses to signal a live pid that cannot be verified over rpc", async () => {
    const manager = new ControlLifecycleManager({
        daemonModulePath: controlDaemonModulePath(),
        pidFile: {
            read: async () => 123,
            remove: async () => undefined,
            write: async () => undefined,
            path: "/tmp/control.pid"
        },
        processIdentity: async () => "unknown",
        processIsRunning: () => true,
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
        waitTimeoutMs: 50
    });

    await assert.rejects(manager.stop(), /Refusing to signal an unverified process/u);
});

test("status times out when a control endpoint accepts but never replies", async (t) => {
    const runtimeRoot = await createTestTempDirectory("control-status-timeout");
    const socketPath = createTestIpcPath("control-status-timeout", runtimeRoot);
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });

    await mkdir(runtimeRoot, { recursive: true });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(runtimeRoot, { force: true, recursive: true });
    });

    const manager = new ControlLifecycleManager({
        daemonModulePath: controlDaemonModulePath(),
        pidFile: {
            read: async () => undefined,
            remove: async () => undefined,
            write: async () => undefined,
            path: "/tmp/control.pid"
        },
        requestTimeoutMs: 50,
        socketFile: {
            ensureRuntimeDir: async () => undefined,
            path: socketPath,
            remove: async () => undefined,
            runtimeDir: runtimeRoot
        }
    });

    const status = await manager.status();

    assert.equal(status.running, false);
});

test("stop tolerates shutdown socket races in the real lifecycle rpc client", async (t) => {
    const runtimeRoot = await createTestTempDirectory("control-stop-race");
    const socketPath = createTestIpcPath("control-stop-race", runtimeRoot);
    let shutdownRequested = false;
    const server = createServer((socket) => {
        if (shutdownRequested) {
            socket.destroy();
            return;
        }

        const channel = SocketChannel.accept(socket);
        const codec = new Codec(channel, { local: "server" });
        codec.onEvent((event) => {
            if (event.name === "service.hello") {
                void codec.send({
                    id: `reply-${event.id}`,
                    replyTo: event.id,
                    destination: "@control",
                    name: "service.hello",
                    payload: {
                        capabilities: ["request", "stream", "streamResume"],
                        protocolVersion: 1,
                    },
                }).catch(() => undefined);
                return;
            }
            if (event.name === "service.status") {
                void codec.send({
                    id: `reply-${event.id}`,
                    replyTo: event.id,
                    destination: "@control",
                    name: "service.status",
                    payload: { instanceCount: 1 }
                }).catch(() => undefined);
                return;
            }

            if (event.name === "service.shutdown") {
                shutdownRequested = true;
                socket.destroy();
            }
        });
    });

    await mkdir(runtimeRoot, { recursive: true });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });

    t.after(async () => {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => error === undefined ? resolve() : reject(error));
        });
        await rm(runtimeRoot, { force: true, recursive: true });
    });

    const manager = new ControlLifecycleManager({
        daemonModulePath: controlDaemonModulePath(),
        pidFile: {
            read: async () => 123,
            remove: async () => undefined,
            write: async () => undefined,
            path: "/tmp/control.pid"
        },
        processIsRunning: () => false,
        socketFile: {
            ensureRuntimeDir: async () => undefined,
            path: socketPath,
            remove: async () => undefined,
            runtimeDir: runtimeRoot
        },
        waitTimeoutMs: 500
    });

    const stopped = await manager.stop();

    assert.equal(shutdownRequested, true);
    assert.equal(stopped.running, false);
});

test("start keeps real worker config registered and does not auto-start worker", async (t) => {
    const homeDirectory = await createTestTempDirectory("control-real-home");
    const xdgRuntimeDir = await createTestTempDirectory("control-real-runtime");
    const restoreWindowsIdentity = installUniqueWindowsTestIdentity("control-registered-config");
    const homePaths = new ControlPathHome(homeDirectory);
    const runtimePaths = new ControlPathRuntime(xdgRuntimeDir);
    const manager = new ControlLifecycleManager({
        daemonModulePath: controlDaemonModulePath(),
        homeDirectory,
        xdgRuntimeDir,
        waitTimeoutMs: 10_000
    });
    const fixturePath = fileURLToPath(new URL("../fixtures/config-valid.toml", import.meta.url));

    t.after(async () => {
        await manager.stop().catch(() => undefined);
        restoreWindowsIdentity();
        await rm(homeDirectory, { force: true, recursive: true });
        await rm(xdgRuntimeDir, { force: true, recursive: true });
    });

    await mkdir(homePaths.controlHomeDir, { recursive: true });
    await writeFile(
        homePaths.configFile,
        (await readFile(fixturePath, "utf8")).replace('listenPort = 17890', "listenPort = 0"),
        "utf8"
    );
    await mkdir(homePaths.instancesDir, { recursive: true });
    await writeFile(
        homePaths.instanceConfigFile("demo-local"),
        encodeInstanceConfig({
            enabled: true,
            mcp: { enabled: true, tools: { capabilities: ["read", "write", "execute"], groups: ["file", "bash", "artifact"] } },
            name: "demo-local",
            provider: "local",
        }),
        "utf8"
    );

    const started = await manager.start();
    assert.equal(started.running, true);
    assert.equal(started.instanceCount, 1);

    const listed = await request(runtimePaths.socketFile, "instance.list");
    assert.equal(Array.isArray(listed), true);
    assert.equal(listed[0]?.name, "demo-local");
    assert.equal(listed[0]?.snapshot.ready, false);
    assert.equal(listed[0]?.snapshot.daemonState, "stopped");
});

async function createHarness(): Promise<{
    cleanup: () => Promise<void>;
    homeDirectory: string;
    manager: ControlLifecycleManager;
    paths: { controlHomeDir: string; socketFile: string };
    xdgRuntimeDir: string;
}> {
    const homeDirectory = await createTestTempDirectory("control-home");
    const xdgRuntimeDir = await createTestTempDirectory("control-runtime");
    const restoreWindowsIdentity = installUniqueWindowsTestIdentity("control-lifecycle-harness");
    const manager = new ControlLifecycleManager({
        daemonModulePath: controlDaemonModulePath(),
        homeDirectory,
        xdgRuntimeDir,
        waitTimeoutMs: 10_000
    });
    const homePaths = new ControlPathHome(homeDirectory);
    const runtimePaths = new ControlPathRuntime(xdgRuntimeDir);

    try {
        await mkdir(homePaths.controlHomeDir, { recursive: true });
        await writeFile(
            homePaths.configFile,
            encodeGlobalConfig({
                control: {
                    logLevel: "info"
                },
                mcp: {
                    enabled: false,
                    listenHost: "127.0.0.1",
                    listenPort: 0
                }
            }),
            "utf8"
        );
    } catch (error) {
        restoreWindowsIdentity();
        await rm(homeDirectory, { force: true, recursive: true });
        await rm(xdgRuntimeDir, { force: true, recursive: true });
        throw error;
    }

    return {
        async cleanup() {
            await manager.stop().catch(() => undefined);
            restoreWindowsIdentity();
            await rm(homeDirectory, { force: true, recursive: true });
            await rm(xdgRuntimeDir, { force: true, recursive: true });
        },
        homeDirectory,
        manager,
        paths: {
            ...homePaths,
            ...runtimePaths
        },
        xdgRuntimeDir
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

function isProcessRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function request(socketPath: string, operation: Event["name"], params?: JsonValue): Promise<any> {
    const [module, method] = operation.split(".");
    const client = new ClientConnection({
        connectChannel: (signal) => SocketChannel.connect(socketPath, { signal }),
        mapError: (error) => error instanceof Error ? error : new Error(String(error)),
        mapRemoteError: (error) => createError(error),
        mode: "persistent",
        peer: "cli"
    });
    try {
        await client.request("@control", "service", "hello", {
            clientKind: "cli",
            maxProtocolVersion: 1,
            minProtocolVersion: 1,
        });
        return await client.request("@control", module!, method!, params);
    } finally {
        client.close();
    }
}
