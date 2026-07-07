import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FrameReader, FrameWriter, type JsonValue } from "@portable-devshell/shared";

import { ControlLifecycleManager } from "../../dist/control/ControlLifecycleManager.js";
import { ControlPathHome } from "../../dist/control/path/ControlPathHome.js";
import { ControlPathRuntime } from "../../dist/control/path/ControlPathRuntime.js";

test("control lifecycle smoke keeps real worker config registered but does not auto-start worker", async (t) => {
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

    await mkdir(homePaths.controlHomeDir, { recursive: true });
    await copyFile(fixturePath, homePaths.configFile);

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
