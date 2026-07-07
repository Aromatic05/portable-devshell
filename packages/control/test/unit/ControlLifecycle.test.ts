import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlLifecycleManager } from "../../dist/control/ControlLifecycleManager.js";
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
