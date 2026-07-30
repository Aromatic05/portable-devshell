import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    CONTROL_WEB_RPC_PATH,
    CONTROL_WEB_SESSION_PATH
} from "@portable-devshell/shared";

import { ControlRuntime } from "../../src/testing.ts";
import { createTestIpcPath, ipcEndpointAcceptsConnections } from "../../../../test/TestPlatformSupport.ts";

test("runtime stop does not settle until owned cleanup completes", async (t) => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-runtime-stop-"));
    const socketPath = createTestIpcPath("control-runtime", runtimeDir);
    let releaseArtifact!: () => void;
    const artifactGate = new Promise<void>((resolve) => {
        releaseArtifact = resolve;
    });
    let artifactStopping = false;
    const runtime = new ControlRuntime({
        artifact: {
            service: undefined,
            async stop() {
                artifactStopping = true;
                await artifactGate;
            }
        } as never,
        instances: {
            list: () => [],
            onChange: () => () => undefined,
            async stopOwned() {}
        } as never,
        mcp: {
            configEditor: undefined,
            instanceCreate: undefined,
            oauthApprovals: () => undefined,
            async start() {},
            status: () => ({ running: false }),
            async stop() {}
        } as never,
        restart: async () => undefined,
        reverse: {
            service: undefined,
            stop() {}
        } as never,
        shutdown: async () => undefined,
        socketPath
    });
    t.after(async () => {
        releaseArtifact();
        await runtime.stop().catch(() => undefined);
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await runtime.start();
    let settled = false;
    const stopping = runtime.stop().finally(() => {
        settled = true;
    });
    await waitFor(() => artifactStopping);

    assert.equal(settled, false);

    releaseArtifact();
    await stopping;
    assert.equal(await ipcEndpointAcceptsConnections(socketPath), false);
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for condition.");
}

test("runtime stop attempts every cleanup step after failures", async (t) => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-runtime-failure-"));
    const socketPath = createTestIpcPath("control-runtime", runtimeDir);
    const calls: string[] = [];
    const runtime = new ControlRuntime({
        artifact: {
            service: undefined,
            async stop() {
                calls.push("artifact");
                throw new Error("artifact stop failed");
            }
        } as never,
        instances: {
            list: () => [],
            onChange: () => () => undefined,
            async stopOwned() {
                calls.push("instances");
                throw new Error("instance stop failed");
            }
        } as never,
        mcp: {
            configEditor: undefined,
            instanceCreate: undefined,
            oauthApprovals: () => undefined,
            async start() {},
            status: () => ({ running: false }),
            async stop() {
                calls.push("mcp");
                throw new Error("mcp stop failed");
            }
        } as never,
        restart: async () => undefined,
        reverse: {
            service: undefined,
            stop() {
                calls.push("reverse");
                throw new Error("reverse stop failed");
            }
        } as never,
        shutdown: async () => undefined,
        socketPath
    });
    t.after(async () => {
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await runtime.start();
    await assert.rejects(runtime.stop(), AggregateError);

    assert.deepEqual(calls, ["reverse", "mcp", "artifact", "instances"]);
    assert.equal(await ipcEndpointAcceptsConnections(socketPath), false);
});

test("runtime mounts web session and RPC routes on the MCP HTTP host", async (t) => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-runtime-web-"));
    const socketPath = createTestIpcPath("control-runtime", runtimeDir);
    const rawRoutes: Array<{ method: string; path: string }> = [];
    const authenticatedRoutes: Array<{ method: string; path: string }> = [];
    const staticRoutes: Array<{ directory: string; path: string }> = [];
    const upgradeRoutes: string[] = [];
    const http = {
        registerAuthenticatedRawRoute(method: string, path: string) {
            authenticatedRoutes.push({ method, path });
        },
        registerRawRoute(method: string, path: string) {
            rawRoutes.push({ method, path });
        },
        registerStaticDirectory(path: string, directory: string) {
            staticRoutes.push({ directory, path });
        },
        registerUpgradeHandler(path: string) {
            upgradeRoutes.push(path);
        }
    };
    const runtime = new ControlRuntime({
        artifact: {
            service: undefined,
            async stop() {}
        } as never,
        instances: {
            list: () => [],
            onChange: () => () => undefined,
            async stopOwned() {}
        } as never,
        mcp: {
            configEditor: undefined,
            host: { server: http },
            instanceCreate: undefined,
            oauthApprovals: undefined,
            publicBaseUrl: "https://devshell.example",
            webEnabled: true,
            async start() {},
            status: () => ({ running: true }),
            async stop() {}
        } as never,
        restart: async () => undefined,
        reverse: {
            service: undefined,
            stop() {}
        } as never,
        shutdown: async () => undefined,
        socketPath
    });
    t.after(async () => {
        await runtime.stop().catch(() => undefined);
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await runtime.start();

    assert.deepEqual(authenticatedRoutes, [
        { method: "post", path: CONTROL_WEB_SESSION_PATH }
    ]);
    assert.deepEqual(rawRoutes, [
        { method: "get", path: CONTROL_WEB_SESSION_PATH },
        { method: "delete", path: CONTROL_WEB_SESSION_PATH }
    ]);
    assert.deepEqual(upgradeRoutes, [CONTROL_WEB_RPC_PATH]);
    assert.equal(staticRoutes.length, 1);
    assert.equal(staticRoutes[0]?.path, "/web");
    assert.match(staticRoutes[0]?.directory ?? "", /[/\\]web[/\\]dist[/\\]?$/u);
});

test("runtime does not mount WebUI routes when web.enabled is false", async (t) => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-runtime-no-web-"));
    const socketPath = createTestIpcPath("control-runtime", runtimeDir);
    const runtime = new ControlRuntime({
        artifact: { service: undefined, async stop() {} } as never,
        instances: {
            list: () => [],
            onChange: () => () => undefined,
            async stopOwned() {}
        } as never,
        mcp: {
            configEditor: undefined,
            host: {
                server: new Proxy({}, {
                    get() {
                        throw new Error("WebUI routes must not be registered.");
                    }
                })
            },
            instanceCreate: undefined,
            oauthApprovals: undefined,
            publicBaseUrl: "http://127.0.0.1:17890",
            webEnabled: false,
            async start() {},
            status: () => ({ running: true }),
            async stop() {}
        } as never,
        restart: async () => undefined,
        reverse: { service: undefined, stop() {} } as never,
        shutdown: async () => undefined,
        socketPath
    });
    t.after(async () => {
        await runtime.stop().catch(() => undefined);
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await runtime.start();
});
