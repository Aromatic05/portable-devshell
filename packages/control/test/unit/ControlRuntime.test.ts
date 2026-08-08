import assert from "node:assert/strict";
import { rename, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import test from "node:test";

import {
    ControlPathHome,
    CONTROL_WEB_RPC_PATH,
    CONTROL_WEB_SESSION_PATH,
    createDefaultControlConfig,
    type ControlConfig
} from "@portable-devshell/shared";

import { ControlRuntime } from "../../src/testing.ts";
import { ControlRuntimeMcp } from "../../src/composition/runtime/ControlRuntimeMcp.ts";
import { ControlRuntimeState } from "../../src/composition/runtime/ControlRuntimeState.ts";
import { createTestIpcPath, ipcEndpointAcceptsConnections } from "../../../../test/TestPlatformSupport.ts";
import { requireTcpPort, startLoopbackHttpProxy } from "../../../../test/TestHttpSupport.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { cleanupInOrder } from "../../../../test/TestCleanup.ts";

test("runtime stop does not settle until owned cleanup completes", async (t) => {
    const runtimeDir = await createTestTempDirectory("runtime-stop");
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
        await cleanupInOrder(
            () => runtime.stop(),
            () => rm(runtimeDir, { force: true, recursive: true }),
        );
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
    const runtimeDir = await createTestTempDirectory("runtime-failure");
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

test("MCP hot replacement preserves the original failure when runtime rollback also fails", async (t) => {
    const runtimeDir = await createTestTempDirectory("runtime-mcp-rollback-errors");
    const socketPath = createTestIpcPath("control-runtime", runtimeDir);
    let applyMcpConfig!: (previous: ControlConfig, next: ControlConfig) => Promise<void>;
    const retired = {
        async stop() {
            throw new Error("retired stop failed");
        }
    };
    const mcp = {
        configEditor: undefined,
        host: undefined,
        instanceCreate: undefined,
        oauthApprovals: undefined,
        async replaceMcpHost() {
            return retired;
        },
        async restoreMcpHost() {
            throw new Error("runtime rollback failed");
        },
        setMcpConfigApplier(apply: (previous: ControlConfig, next: ControlConfig) => Promise<void>) {
            applyMcpConfig = apply;
        },
        webEnabled: false,
        async start() {},
        status: () => ({ running: false }),
        async stop() {}
    };
    new ControlRuntime({
        artifact: { service: undefined, async stop() {} } as never,
        instances: {
            list: () => [],
            onChange: () => () => undefined,
            async stopOwned() {}
        } as never,
        mcp: mcp as never,
        restart: async () => undefined,
        reverse: { service: undefined, stop() {} } as never,
        shutdown: async () => undefined,
        socketPath
    });
    t.after(async () => await rm(runtimeDir, { force: true, recursive: true }));
    const previous = createDefaultControlConfig();
    const next = structuredClone(previous);
    next.mcp.publicBaseUrl = "https://new.example";

    await assert.rejects(
        applyMcpConfig(previous, next),
        (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(
                error.errors.map((entry) => (entry as Error).message),
                ["retired stop failed", "runtime rollback failed"]
            );
            return true;
        }
    );
});

test("Web hot replacement preserves the original failure when host rollback also fails", async (t) => {
    const runtimeDir = await createTestTempDirectory("runtime-web-rollback-errors");
    const socketPath = createTestIpcPath("control-runtime", runtimeDir);
    let applyWebConfig!: (previous: ControlConfig, next: ControlConfig) => Promise<void>;
    const http = {};
    const mcp = {
        configEditor: undefined,
        instanceCreate: undefined,
        oauthApprovals: undefined,
        webAuth: { mode: "none" },
        webEnabled: true,
        webHost: http,
        webPublicBaseUrl: "http://127.0.0.1",
        async replaceWebHost() {
            return http;
        },
        async restoreWebHost() {
            throw new Error("web host rollback failed");
        },
        setWebConfigApplier(apply: (previous: ControlConfig, next: ControlConfig) => Promise<void>) {
            applyWebConfig = apply;
        },
        async stopRetiredWebHost() {},
        async start() {},
        status: () => ({ running: false }),
        async stop() {}
    };
    new ControlRuntime({
        artifact: { service: undefined, async stop() {} } as never,
        instances: {
            list: () => [],
            onChange: () => () => undefined,
            async stopOwned() {}
        } as never,
        mcp: mcp as never,
        restart: async () => undefined,
        reverse: { service: undefined, stop() {} } as never,
        shutdown: async () => undefined,
        socketPath
    });
    t.after(async () => await rm(runtimeDir, { force: true, recursive: true }));
    const previous = createDefaultControlConfig();
    previous.web.enabled = true;
    const next = structuredClone(previous);
    next.web.listenPort = previous.web.listenPort + 1;

    await assert.rejects(
        applyWebConfig(previous, next),
        (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.equal(error.errors.length, 2);
            assert.match((error.errors[0] as Error).message, /not started/iu);
            assert.equal((error.errors[1] as Error).message, "web host rollback failed");
            return true;
        }
    );
});

test("runtime mounts web session and RPC routes on the MCP HTTP host", async (t) => {
    const runtimeDir = await createTestTempDirectory("runtime-web");
    const socketPath = createTestIpcPath("control-runtime", runtimeDir);
    const rawRoutes: Array<{ method: string; path: string }> = [];
    const authenticatedRoutes: Array<{ method: string; path: string }> = [];
    const staticRoutes: Array<{ directory: string; path: string }> = [];
    const upgradeRoutes: string[] = [];
    const http = {
        registerAuthenticatedRawRoute(method: string, path: string) {
            authenticatedRoutes.push({ method, path });
            return () => undefined;
        },
        registerRawRoute(method: string, path: string) {
            rawRoutes.push({ method, path });
            return () => undefined;
        },
        registerStaticDirectory(path: string, directory: string) {
            staticRoutes.push({ directory, path });
            return () => undefined;
        },
        registerUpgradeHandler(path: string) {
            upgradeRoutes.push(path);
            return () => undefined;
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
            instanceCreate: undefined,
            oauthApprovals: undefined,
            webAuth: { mode: "none" },
            webHost: http,
            webPublicBaseUrl: "https://devshell.example",
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
        await cleanupInOrder(
            () => runtime.stop(),
            () => rm(runtimeDir, { force: true, recursive: true }),
        );
    });

    await runtime.start();

    assert.deepEqual(authenticatedRoutes, []);
    assert.deepEqual(rawRoutes, [
        { method: "post", path: CONTROL_WEB_SESSION_PATH },
        { method: "get", path: CONTROL_WEB_SESSION_PATH },
        { method: "delete", path: CONTROL_WEB_SESSION_PATH }
    ]);
    assert.deepEqual(upgradeRoutes, [CONTROL_WEB_RPC_PATH, "/control/v1/connect"]);
    assert.equal(staticRoutes.length, 1);
    assert.equal(staticRoutes[0]?.path, "/web");
    assert.match(staticRoutes[0]?.directory ?? "", /[/\\]web[/\\]dist[/\\]?$/u);
});

test("runtime does not mount WebUI routes when web.enabled is false", async (t) => {
    const runtimeDir = await createTestTempDirectory("runtime-no-web");
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
        await cleanupInOrder(
            () => runtime.stop(),
            () => rm(runtimeDir, { force: true, recursive: true }),
        );
    });

    await runtime.start();
});

test("failed OAuth Web hot replacement restores the previous listener and OAuth routes", async (t) => {
    const homeDirectory = await createTestTempDirectory("runtime-web-rollback");
    const socketPath = createTestIpcPath("control-runtime", homeDirectory);
    const proxy = await startLoopbackHttpProxy();
    const origin = proxy.origin;
    let persisted = createDefaultControlConfig();
    persisted.web = {
        auth: {
            mode: "oauth2",
            oauth2: { requiredScopes: ["web"], resourceName: "web-before" }
        },
        enabled: true,
        listenHost: "127.0.0.1",
        listenPort: 0,
        publicBaseUrl: origin
    };
    const state = new ControlRuntimeState({
        configStore: {
            async readOrCreate() {
                return persisted;
            },
            async write(config: ControlConfig) {
                persisted = config;
            }
        } as never,
        homeDirectory
    });
    await state.load();
    const controlPaths = new ControlPathHome(homeDirectory);
    const artifact = {
        installHttpRoute() {},
        service: undefined,
        async stop() {}
    } as never;
    const mcp = new ControlRuntimeMcp({
        artifact,
        controlPaths,
        state
    });
    const runtime = new ControlRuntime({
        artifact,
        instances: state.instances,
        mcp,
        restart: async () => undefined,
        reverse: { service: undefined, stop() {} } as never,
        shutdown: async () => undefined,
        socketPath
    });
    t.after(async () => {
        try {
            await runtime.stop();
            await rm(homeDirectory, { force: true, recursive: true });
        } finally {
            await proxy.close();
        }
    });

    await runtime.start();
    proxy.setTarget(`http://127.0.0.1:${requireTcpPort(mcp.webHost?.address)}`);
    const initialMetadata = await requestHttp(origin, "/.well-known/oauth-protected-resource/web");
    assert.equal(initialMetadata.status, 200);

    const oauthStorage = mcp.webOauthDir;
    const oauthBackup = `${oauthStorage}.backup`;
    await rename(oauthStorage, oauthBackup);
    await writeFile(oauthStorage, "block replacement warmup", "utf8");

    await assert.rejects(
        mcp.configEditor.updateWebConfig({
            patch: {
                auth: "oauth2",
                oauth2: { requiredScopes: ["web"], resourceName: "web-after" }
            }
        }),
        /EEXIST|ENOTDIR|not a directory/iu
    );
    proxy.setTarget(`http://127.0.0.1:${requireTcpPort(mcp.webHost?.address)}`);

    assert.equal(persisted.web.auth.mode, "oauth2");
    if (persisted.web.auth.mode !== "oauth2") throw new Error("restored Web auth mode is not oauth2");
    assert.equal(persisted.web.auth.oauth2.resourceName, "web-before");
    const restoredSession = await requestHttp(origin, "/web/session");
    assert.equal(restoredSession.status, 200);
    const restoredMetadata = await requestHttp(origin, "/.well-known/oauth-protected-resource/web");
    assert.equal(restoredMetadata.status, 200);
    assert.equal((JSON.parse(restoredMetadata.body) as { resource_name: string }).resource_name, "web-before");
});

async function requestHttp(origin: string, path: string): Promise<{ body: string; status: number }> {
    return await new Promise((resolve, reject) => {
        const requestHandle = request(new URL(path, origin), {
            agent: false,
            headers: { connection: "close" },
            method: "GET"
        }, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("error", reject);
            response.once("end", () => resolve({
                body: Buffer.concat(chunks).toString("utf8"),
                status: response.statusCode ?? 0
            }));
        });
        requestHandle.once("error", reject);
        requestHandle.end();
    });
}
