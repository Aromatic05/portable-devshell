import assert from "node:assert/strict";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { createServer as createNetServer } from "node:net";
import test from "node:test";

import {
    EXTENSION_API_VERSION,
    EXTENSION_MANIFEST_SCHEMA_VERSION,
} from "@portable-devshell/extension";

import { ControlPathHome, Endpoint, LocalChannel, ServerSession, type JsonValue, createDefaultControlConfig, createEmptyMessagePreferences, createServerTransport, createToolTransport, type ControlConfig } from "@portable-devshell/shared";
import { CONTROL_WEB_RPC_PATH, CONTROL_WEB_SESSION_PATH } from "@portable-devshell/shared/testing";

import { ControlRuntime, type ControlRuntimeOptions } from "../../../../src/server/runtime/Runtime.ts";
import { ConfigChangeHub } from "../../../../src/config/change/Config.ts";
import { ExtensionPathLayout } from "../../../../src/extension/state/Layout.ts";
import { McpControlModule } from "../../../../src/server/mcp/Module.ts";
import { ControlWebRuntime } from "../../../../src/server/web/Runtime.ts";
import { createContextRuntime } from "@portable-devshell/core/context";
import { InstanceRegistry } from "@portable-devshell/core/instance";
import { ControlRuntimeState } from "../../../../src/server/runtime/State.ts";
import { createToolCallRegistry } from "../../../../src/toolcall/Public.ts";
import {
    createTestIpcPath,
    ipcEndpointAcceptsConnections,
} from "../../../../../../test/TestPlatformSupport.ts";
import {
    requireTcpPort,
    startLoopbackHttpProxy,
} from "../../../../../../test/TestHttpSupport.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";
import { cleanupInOrder } from "../../../../../../test/TestCleanup.ts";

test("runtime stop does not settle until owned cleanup completes", async (t) => {
    const runtimeDir = await createTestTempDirectory("runtime-stop");
    const socketPath = createTestIpcPath("control-runtime", runtimeDir);
    let releaseArtifact!: () => void;
    const artifactGate = new Promise<void>((resolve) => {
        releaseArtifact = resolve;
    });
    let artifactStopping = false;
    const runtime = createControlRuntime({
        contexts: testContexts(join(runtimeDir, "contexts.json")),
        configChanges: new ConfigChangeHub(),
        extensionPaths: testExtensionPaths(),
        extensions: testExtensions(),
        artifact: {
            service: undefined,
            async stop() {
                artifactStopping = true;
                await artifactGate;
            },
        } as never,
        instances: {
            list: () => [],
            onChange: () => () => undefined,
            async stopOwned() {},
        } as never,
        mcp: {
            async prepare() {},
            async start() {},
            status: () => ({ running: false }),
            async stop() {},
        } as never,
        restart: async () => undefined,
        reverse: {
            service: undefined,
            stop() {},
        } as never,
        shutdown: async () => undefined,
        socketPath,
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

test("runtime startup preserves cleanup failures from rollback", async (t) => {
    const runtimeDir = await createTestTempDirectory("runtime-start-rollback");
    const socketPath = createTestIpcPath("control-runtime-start", runtimeDir);
    const calls: string[] = [];
    const runtime = createControlRuntime({
        contexts: testContexts(join(runtimeDir, "contexts.json")),
        configChanges: new ConfigChangeHub(),
        artifact: { service: undefined, async stop() {} } as never,
        extensionPaths: testExtensionPaths(),
        extensions: testExtensions(),
        instances: {
            list: () => [],
            onChange: () => () => undefined,
            async stopOwned() {},
        } as never,
        mcp: {
            async prepare() {},
            async start() {
                calls.push("mcp.start");
                throw new Error("mcp start failed");
            },
            status: () => ({ running: false }),
            async stop() {
                calls.push("mcp.stop");
                throw new Error("mcp stop failed");
            },
        } as never,
        restart: async () => undefined,
        reverse: { service: undefined, stop() {} } as never,
        shutdown: async () => undefined,
        socketPath,
    });
    t.after(async () => {
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await assert.rejects(runtime.start(), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal((error.errors[0] as Error).message, "mcp start failed");
        const cleanup = error.errors[1];
        assert.ok(cleanup instanceof AggregateError);
        assert.match(cleanup.message, /failed to stop cleanly/u);
        return true;
    });
    assert.deepEqual(calls, ["mcp.start", "mcp.stop"]);
});

test("MCP runtime stop attempts both independent listener hosts", async (t) => {
    const calls: string[] = [];
    const runtimeDir = await createTestTempDirectory("runtime-stop-all-hosts");
    const runtime = createControlRuntime({
        socketPath: createTestIpcPath("control-runtime", runtimeDir),
        mcp: {
            async stop() {
                calls.push("mcp");
                throw new Error("mcp host stop failed");
            },
        } as never,
        web: {
            async stopHost() {
                calls.push("web");
                throw new Error("web host stop failed");
            },
        } as never,
    });
    t.after(async () => await rm(runtimeDir, { force: true, recursive: true }));

    await runtime.start();
    await assert.rejects(runtime.stop(), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(
            error.errors.map((entry) => (entry as Error).message),
            ["web host stop failed", "mcp host stop failed"],
        );
        return true;
    });
    assert.deepEqual(calls, ["web", "mcp"]);
});

test("runtime registers one Extension generation retirement handler", async (t) => {
    const runtimeDir = await createTestTempDirectory(
        "runtime-extension-lifecycle",
    );
    const socketPath = createTestIpcPath(
        "control-runtime-extension",
        runtimeDir,
    );
    const lifecycle: string[] = [];
    let disableRetirements = 0;
    let deleteRetirements = 0;
    const generationRetirements: Array<
        (instance: { name: string }) => Promise<void>
    > = [];
    const runtime = createControlRuntime({
        contexts: testContexts(join(runtimeDir, "contexts.json")),
        configChanges: new ConfigChangeHub(),
        artifact: { service: undefined, async stop() {} } as never,
        extensionPaths: testExtensionPaths(),
        extensions: {
            ...testExtensionSurface(),
            async retireInstanceGeneration(instance: string) {
                lifecycle.push(`extension:${instance}`);
                lifecycle.push(`resources:${instance}`);
            },
        } as never,
        instanceEditor: {
            ...testInstanceEditor(),
            registerInstanceDisableRetirement() {
                disableRetirements += 1;
                return () => undefined;
            },
            registerInstanceDeleteRetirement() {
                deleteRetirements += 1;
                return () => undefined;
            },
            registerInstanceGenerationRetirement(
                listener: (instance: { name: string }) => Promise<void>,
            ) {
                generationRetirements.push(listener);
                return () => undefined;
            },
        } as never,
        instances: {
            list: () => [],
            onChange: () => () => undefined,
            async stopOwned() {},
        } as never,
        mcp: {
            setToolCalls() {},
            async prepare() {},
            async start() {},
            status: () => ({ running: false }),
            async stop() {},
        } as never,
        restart: async () => undefined,
        reverse: { service: undefined, stop() {} } as never,
        shutdown: async () => undefined,
        socketPath,
    });
    t.after(async () => {
        await runtime.stop().catch(() => undefined);
        await rm(runtimeDir, { force: true, recursive: true });
    });

    assert.equal(disableRetirements, 0);
    assert.equal(deleteRetirements, 0);
    assert.equal(generationRetirements.length, 3);
    for (const retire of generationRetirements) {
        await retire({ name: "alpha" });
    }
    assert.deepEqual(lifecycle, ["extension:alpha", "resources:alpha"]);
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for condition.");
}

function testInstanceEditor() {
    return {
        registerInstanceDisabled() { return () => undefined; },
        registerInstanceDisableRetirement() { return () => undefined; },
        registerInstanceDeleted() { return () => undefined; },
        registerInstanceDeleteRetirement() { return () => undefined; },
        registerInstanceGenerationRetirement() { return () => undefined; },
        async reconcileCleanupDebt() {},
    };
}

function testContexts(contextFile: string) {
    return createContextRuntime({
        contextFile,
        instances: new InstanceRegistry([]),
    });
}

function createControlRuntime(
    overrides: Partial<ControlRuntimeOptions> & Pick<ControlRuntimeOptions, "socketPath">,
): ControlRuntime {
    const instances = new InstanceRegistry([]);
    const endpoint = new Endpoint({ connectChannel: () => Promise.reject(new Error("Unexpected internal connection.")) as never });
    const noOpEditor = testInstanceEditor();
    const web = {
        listener: undefined,
        async prepare() {},
        async startHost() {},
        async stopHost() {},
        stop() {},
        async replace() {},
    };
    const mcp = {
        setToolCalls() {}, setWebConfigApplier() {}, setMcpConfigApplier() {},
        host: undefined, async start() {}, async stop() {},
        async replaceMcpHost() { return undefined; },
        async restoreMcpHost() {}, status: () => ({ running: false }),
    };
    const options = {
        artifact: { service: undefined, installHttpRoute() {}, async stop() {} } as never,
        configChanges: new ConfigChangeHub(),
        configEditor: noOpEditor as never,
        contexts: testContexts(join(dirname(overrides.socketPath), "contexts.json")),
        contextTransport: {} as never,
        extensionPaths: testExtensionPaths(),
        extensions: testExtensions(),
        instanceCreate: {} as never,
        instanceEditor: noOpEditor as never,
        instanceChanges: { onChange: () => () => undefined } as never,
        instanceRuntimes: { get: () => { throw new Error("Unexpected instance runtime lookup."); }, async close() {} } as never,
        instances,
        internalControl: { endpoint, server: { async hello() {} } as never },
        restart: async () => undefined,
        reverse: { service: undefined, install() {}, stop() {} } as never,
        shutdown: async () => undefined,
        toolCalls: createToolCallRegistry(),
        ...overrides,
        mcp: mergeOwner(mcp, overrides.mcp),
        web: mergeOwner(web, overrides.web),
    } as unknown as ControlRuntimeOptions;
    return new ControlRuntime(options);
}

function mergeOwner<T extends object>(fallback: T, override: unknown): T {
    if (override === undefined) return fallback;
    if (Object.getPrototypeOf(override) !== Object.prototype) return override as T;
    return { ...fallback, ...override };
}

function testExtensionSurface() {
    return {
        async acquireRegistration() {
            throw new Error("No test Extension registration.");
        },
        async disable() {},
        async enable() {},
        listDeclarations() {
            return [];
        },
        async list() {
            return [];
        },
        onChange() {
            return () => undefined;
        },
        async contextEnvironmentRetired() {},
        async reload() {},
        async retireInstanceGeneration() {},
        async start() {},
        async stop() {},
    };
}

function testExtensions() {
    return testExtensionSurface() as never;
}

function testExtensionPaths() {
    return {
        generationDirectory: (id: string, generation: string) =>
            `/extensions/${id}/${generation}`,
    } as never;
}

test("runtime stop attempts every remaining cleanup after failures", async (t) => {
    const runtimeDir = await createTestTempDirectory("runtime-failure");
    const socketPath = createTestIpcPath("control-runtime", runtimeDir);
    const calls: string[] = [];
    const runtime = createControlRuntime({
        contexts: testContexts(join(runtimeDir, "contexts.json")),
        configChanges: new ConfigChangeHub(),
        extensionPaths: testExtensionPaths(),
        extensions: testExtensions(),
        artifact: {
            service: undefined,
            async stop() {
                calls.push("artifact");
                throw new Error("artifact stop failed");
            },
        } as never,
        mcp: {
            async prepare() {},
            async start() {},
            status: () => ({ running: false }),
            async stop() {
                calls.push("mcp");
                throw new Error("mcp stop failed");
            },
        } as never,
        restart: async () => undefined,
        reverse: {
            service: undefined,
            stop() {
                calls.push("reverse");
                throw new Error("reverse stop failed");
            },
        } as never,
        shutdown: async () => undefined,
        socketPath,
    });
    t.after(async () => {
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await runtime.start();
    await assert.rejects(runtime.stop(), AggregateError);

    assert.deepEqual(calls, ["mcp", "reverse", "artifact"]);
    assert.equal(await ipcEndpointAcceptsConnections(socketPath), false);
});

test("MCP hot replacement preserves the original failure when runtime rollback also fails", async (t) => {
    const runtimeDir = await createTestTempDirectory(
        "runtime-mcp-rollback-errors",
    );
    const socketPath = createTestIpcPath("control-runtime", runtimeDir);
    let applyMcpConfig!: (
        previous: ControlConfig,
        next: ControlConfig,
    ) => Promise<void>;
    const retired = {
        async stop() {
            throw new Error("retired stop failed");
        },
    };
    const mcp = {
        host: undefined,
        async replaceMcpHost() {
            return retired;
        },
        async restoreMcpHost() {
            throw new Error("runtime rollback failed");
        },
        setMcpConfigApplier(
            apply: (
                previous: ControlConfig,
                next: ControlConfig,
            ) => Promise<void>,
        ) {
            applyMcpConfig = apply;
        },
        async prepare() {},
        async start() {},
        status: () => ({ running: false }),
        async stop() {},
    };
    const runtime = createControlRuntime({
        contexts: testContexts(join(runtimeDir, "contexts.json")),
        configChanges: new ConfigChangeHub(),
        extensionPaths: testExtensionPaths(),
        extensions: testExtensions(),
        artifact: { service: undefined, async stop() {} } as never,
        instances: {
            list: () => [],
            onChange: () => () => undefined,
            async stopOwned() {},
        } as never,
        mcp: mcp as never,
        restart: async () => undefined,
        reverse: { service: undefined, stop() {} } as never,
        shutdown: async () => undefined,
        socketPath,
    });
    t.after(async () => {
        await cleanupInOrder(
            () => runtime.stop(),
            () => rm(runtimeDir, { force: true, recursive: true }),
        );
    });
    const previous = createDefaultControlConfig();
    const next = structuredClone(previous);
    next.mcp.publicBaseUrl = "https://new.example";

    await assert.rejects(applyMcpConfig(previous, next), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(
            error.errors.map((entry) => (entry as Error).message),
            ["retired stop failed", "runtime rollback failed"],
        );
        return true;
    });
});

test("Web hot replacement preserves the original failure when host rollback also fails", async (t) => {
    const runtimeDir = await createTestTempDirectory(
        "runtime-web-rollback-errors",
    );
    const socketPath = createTestIpcPath("control-runtime", runtimeDir);
    let applyWebConfig!: (
        previous: ControlConfig,
        next: ControlConfig,
    ) => Promise<void>;
    const mcp = {
        setWebConfigApplier(
            apply: (
                previous: ControlConfig,
                next: ControlConfig,
            ) => Promise<void>,
        ) {
            applyWebConfig = apply;
        },
        async stop() {},
    };
    const web = {
        listener: undefined,
        async prepare() {},
        async startHost() {},
        async stopHost() {},
        stop() {},
        async replace() {
            throw new AggregateError(
                [
                    new Error("web host was not started"),
                    new Error("web host rollback failed"),
                ],
            );
        },
    };
    const runtime = createControlRuntime({
        contexts: testContexts(
            join("/tmp", `runtime-context-${Date.now()}.json`),
        ),
        configChanges: new ConfigChangeHub(),
        extensionPaths: testExtensionPaths(),
        extensions: testExtensions(),
        artifact: { service: undefined, async stop() {} } as never,
        instances: {
            list: () => [],
            onChange: () => () => undefined,
            async stopOwned() {},
        } as never,
        mcp: mcp as never,
        web: web as never,
        restart: async () => undefined,
        reverse: { service: undefined, stop() {} } as never,
        shutdown: async () => undefined,
        socketPath,
    });
    t.after(async () => {
        await cleanupInOrder(
            () => runtime.stop(),
            () => rm(runtimeDir, { force: true, recursive: true }),
        );
    });
    const previous = createDefaultControlConfig();
    previous.web.enabled = true;
    const next = structuredClone(previous);
    next.web.listenPort = previous.web.listenPort + 1;

    await assert.rejects(applyWebConfig(previous, next), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.match((error.errors[0] as Error).message, /not started/iu);
        assert.equal(
            (error.errors[1] as Error).message,
            "web host rollback failed",
        );
        return true;
    });
});

test("runtime mounts web session and RPC routes on the MCP HTTP host", async (t) => {
    const runtimeDir = await createTestTempDirectory("runtime-web");
    const socketPath = createTestIpcPath("control-runtime", runtimeDir);
    const rawRoutes: Array<{ method: string; path: string }> = [];
    const rawPrefixes: string[] = [];
    const authenticatedRoutes: Array<{ method: string; path: string }> = [];
    const staticRoutes: Array<{ directory: string; path: string }> = [];
    const upgradeRoutes: string[] = [];
    const upgradePrefixes: string[] = [];
    const config = createDefaultControlConfig();
    config.mcp.enabled = true;
    config.mcp.publicBaseUrl = "https://devshell.example";
    config.web.enabled = true;
    config.web.publicBaseUrl = "https://devshell.example";
    const http = {
        registerAuthenticatedRawRoute(method: string, path: string) {
            authenticatedRoutes.push({ method, path });
            return () => undefined;
        },
        registerRawRoute(method: string, path: string) {
            rawRoutes.push({ method, path });
            return () => undefined;
        },
        registerRawPrefix(path: string) {
            rawPrefixes.push(path);
            return () => undefined;
        },
        registerStaticDirectory(path: string, directory: string) {
            staticRoutes.push({ directory, path });
            return () => undefined;
        },
        registerUpgradeHandler(path: string) {
            upgradeRoutes.push(path);
            return () => undefined;
        },
        registerUpgradePrefix(path: string) {
            upgradePrefixes.push(path);
            return () => undefined;
        },
    };
    const mcp = {
        host: { server: http },
        oauthApproval: config.mcp.oauth2,
        publicBaseUrl: config.mcp.publicBaseUrl,
    };
    const web = new ControlWebRuntime({
        config,
        extensions: testExtensions(),
        mcp: mcp as never,
        oauthDirectory: join(runtimeDir, "oauth"),
        paths: testExtensionPaths(),
    });
    const runtime = createControlRuntime({
        config: () => config,
        contexts: testContexts(join(runtimeDir, "contexts.json")),
        configChanges: new ConfigChangeHub(),
        extensionPaths: testExtensionPaths(),
        extensions: testExtensions(),
        artifact: {
            service: undefined,
            async stop() {},
        } as never,
        instances: {
            list: () => [],
            onChange: () => () => undefined,
            async stopOwned() {},
        } as never,
        mcp: {
            host: mcp.host,
            oauthApproval: config.mcp.oauth2,
            publicBaseUrl: config.mcp.publicBaseUrl,
        } as never,
        web,
        restart: async () => undefined,
        reverse: {
            service: undefined,
            stop() {},
        } as never,
        shutdown: async () => undefined,
        socketPath,
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
        { method: "delete", path: CONTROL_WEB_SESSION_PATH },
    ]);
    assert.deepEqual(upgradeRoutes, [
        CONTROL_WEB_RPC_PATH,
        "/control/v1/connect",
    ]);
    assert.deepEqual(rawPrefixes, ["/web/extensions"]);
    assert.deepEqual(upgradePrefixes, ["/web/extensions"]);
    assert.equal(staticRoutes.length, 1);
    assert.equal(staticRoutes[0]?.path, "/web");
    assert.match(staticRoutes[0]?.directory ?? "", /[/\\]web[/\\]dist[/\\]?$/u);
});

test("runtime does not mount WebUI routes when web.enabled is false", async (t) => {
    const runtimeDir = await createTestTempDirectory("runtime-no-web");
    const socketPath = createTestIpcPath("control-runtime", runtimeDir);
    const runtime = createControlRuntime({
        contexts: testContexts(join(runtimeDir, "contexts.json")),
        configChanges: new ConfigChangeHub(),
        extensionPaths: testExtensionPaths(),
        extensions: testExtensions(),
        artifact: { service: undefined, async stop() {} } as never,
        instances: {
            list: () => [],
            onChange: () => () => undefined,
            async stopOwned() {},
        } as never,
        mcp: {
            host: {
                server: new Proxy(
                    {},
                    {
                        get() {
                            throw new Error(
                                "WebUI routes must not be registered.",
                            );
                        },
                    },
                ),
            },
            publicBaseUrl: "http://127.0.0.1:17890",
            async prepare() {},
            async start() {},
            status: () => ({ running: true }),
            async stop() {},
        } as never,
        restart: async () => undefined,
        reverse: { service: undefined, stop() {} } as never,
        shutdown: async () => undefined,
        socketPath,
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
    const port = await reserveTcpPort();
    const origin = `http://127.0.0.1:${port}`;
    const persisted = createDefaultControlConfig();
    persisted.mcp.enabled = false;
    persisted.web = {
        auth: {
            mode: "oauth2",
            oauth2: { requiredScopes: ["web"], resourceName: "web-before" },
        },
        enabled: true,
        listenHost: "127.0.0.1",
        listenPort: port,
        publicBaseUrl: origin,
    };
    const controlPaths = new ControlPathHome(homeDirectory);
    const artifact = {
        installHttpRoute() {},
        service: undefined,
        async stop() {},
    } as never;
    const instances = new InstanceRegistry([]);
    const mcp = new McpControlModule({
        artifact,
        config: persisted,
        contextTransport: {} as never,
        controlPaths,
        instances,
        toolRegistry: createToolCallRegistry(),
    });
    const web = new ControlWebRuntime({
        config: persisted,
        extensions: testExtensions(),
        mcp,
        oauthDirectory: controlPaths.oauthDir,
        paths: testExtensionPaths(),
    });
    const runtime = createControlRuntime({
        config: () => persisted,
        configChanges: new ConfigChangeHub(),
        contexts: createContextRuntime({
            contextFile: controlPaths.contextsFile,
            instances,
        }),
        extensionPaths: testExtensionPaths(),
        extensions: testExtensions(),
        artifact,
        instances,
        mcp,
        web,
        restart: async () => undefined,
        reverse: { service: undefined, stop() {} } as never,
        shutdown: async () => undefined,
        socketPath,
    });
    t.after(async () => {
        await cleanupInOrder(
            () => runtime.stop(),
            () => rm(homeDirectory, { force: true, recursive: true }),
        );
    });

    await runtime.start();
    const initialMetadata = await requestHttp(
        origin,
        "/.well-known/oauth-protected-resource/web",
    );
    assert.equal(initialMetadata.status, 200);

    const oauthStorage = controlPaths.oauthDir;
    const oauthBackup = `${oauthStorage}.backup`;
    await rename(oauthStorage, oauthBackup);
    await writeFile(oauthStorage, "block replacement warmup", "utf8");

    const next = structuredClone(persisted);
    next.web.auth = {
        mode: "oauth2",
        oauth2: { requiredScopes: ["web"], resourceName: "web-after" },
    };
    await assert.rejects(
        mcp.applyRuntimeConfig(persisted, next, {
            instanceAuth: false,
            mcp: false,
            web: true,
        }),
        /EEXIST|ENOTDIR|not a directory/iu,
    );

    assert.equal(persisted.web.auth.mode, "oauth2");
    if (persisted.web.auth.mode !== "oauth2")
        throw new Error("restored Web auth mode is not oauth2");
    assert.equal(persisted.web.auth.oauth2.resourceName, "web-before");
    const restoredSession = await requestHttp(origin, "/web/session");
    assert.equal(restoredSession.status, 200);
    const restoredMetadata = await requestHttp(
        origin,
        "/.well-known/oauth-protected-resource/web",
    );
    assert.equal(restoredMetadata.status, 200);
    assert.equal(
        (JSON.parse(restoredMetadata.body) as { resource_name: string })
            .resource_name,
        "web-before",
    );
});

async function requestHttp(
    origin: string,
    path: string,
): Promise<{ body: string; status: number }> {
    return await new Promise((resolve, reject) => {
        const requestHandle = request(
            new URL(path, origin),
            {
                agent: false,
                headers: { connection: "close" },
                method: "GET",
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.once("error", reject);
                response.once("end", () =>
                    resolve({
                        body: Buffer.concat(chunks).toString("utf8"),
                        status: response.statusCode ?? 0,
                    }),
                );
            },
        );
        requestHandle.once("error", reject);
        requestHandle.end();
    });
}

async function reserveTcpPort(): Promise<number> {
    const server = createNetServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    await new Promise<void>((resolve, reject) =>
        server.close((error) =>
            error === undefined ? resolve() : reject(error),
        ),
    );
    return address.port;
}

test("runtime installs builtin Extensions through the normal installer after opening the Control channel", async (t) => {
    const root = await createTestTempDirectory("runtime-builtin-extension");
    const socketPath = createTestIpcPath("control-runtime-builtin", root);
    const source = join(root, "builtin-source");
    await mkdir(source, { recursive: true });
    await writeFile(
        join(source, "devshell-extension.json"),
        `${JSON.stringify({
            activation: "lazy",
            apiVersion: EXTENSION_API_VERSION,
            capabilities: [],
            entry: "extension.mjs",
            id: "skill",
            name: "Skill builtin",
            schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
            version: "1.0.0",
        })}\n`,
        "utf8",
    );
    await writeFile(
        join(source, "extension.mjs"),
        "export function activate() { return { dispose() {} }; }\n",
        "utf8",
    );

    const extensionPaths = new ExtensionPathLayout({
        dataHome: join(root, "data"),
        homeDirectory: join(root, "home"),
        runtimeRoot: join(root, "runtime"),
    });
    let selectedGeneration: string | undefined;
    const extensions = {
        async acquireRegistration() {
            throw new Error("No test Extension registration.");
        },
        async selectGeneration(id: string, generation: string) {
            assert.equal(id, "skill");
            assert.equal(
                await ipcEndpointAcceptsConnections(socketPath),
                true,
            );
            selectedGeneration = generation;
        },
        async disable() {},
        async enable() {},
        async forget() {},
        listDeclarations() {
            return [];
        },
        async list() {
            return selectedGeneration === undefined
                ? []
                : [
                      {
                          enabled: true,
                          id: "skill",
                          retired: [],
                          selectedGeneration,
                          state: "installed",
                          version: "1.0.0",
                      },
                  ];
        },
        onChange() {
            return () => undefined;
        },
        async contextEnvironmentRetired() {},
        async reload() {},
        async retireInstanceGeneration() {},
        async start() {},
        async stop() {},
        async waitForDrain() {},
    } as never;
    const runtime = createControlRuntime({
        contexts: testContexts(join(root, "contexts.json")),
        configChanges: new ConfigChangeHub(),
        artifact: {
            service: undefined,
            async stop() {},
        } as never,
        builtinExtensionSources: [{ id: "skill", path: source }],
        extensionPaths,
        extensions,
        instances: {
            list: () => [],
            onChange: () => () => undefined,
            async stopOwned() {},
        } as never,
        mcp: {
            async prepare() {},
            async start() {},
            status: () => ({ running: false }),
            async stop() {},
        } as never,
        restart: async () => undefined,
        reverse: { service: undefined, stop() {} } as never,
        shutdown: async () => undefined,
        socketPath,
    });
    t.after(async () => {
        await cleanupInOrder(
            () => runtime.stop(),
            () => rm(root, { force: true, recursive: true }),
        );
    });

    await runtime.start();
    assert.match(selectedGeneration ?? "", /^v1\.0\.0-[0-9a-f]{64}$/u);
    assert.equal(await ipcEndpointAcceptsConnections(socketPath), true);
});

test("runtime keeps the Control channel closed when builtin Extension installation fails", async (t) => {
    const root = await createTestTempDirectory(
        "runtime-builtin-extension-failure",
    );
    const socketPath = createTestIpcPath(
        "control-runtime-builtin-failure",
        root,
    );
    const source = join(root, "invalid-builtin");
    await mkdir(source, { recursive: true });
    const runtime = createControlRuntime({
        contexts: testContexts(join(root, "contexts.json")),
        configChanges: new ConfigChangeHub(),
        artifact: { service: undefined, async stop() {} } as never,
        builtinExtensionSources: [{ id: "skill", path: source }],
        extensionPaths: new ExtensionPathLayout({
            dataHome: join(root, "data"),
            homeDirectory: join(root, "home"),
            runtimeRoot: join(root, "runtime"),
        }),
        extensions: {
            async acquireRegistration() {
                throw new Error("No test Extension registration.");
            },
            async disable() {},
            async enable() {},
            async forget() {},
            listDeclarations() {
                return [];
            },
            async list() {
                return [];
            },
            onChange() {
                return () => undefined;
            },
            async contextEnvironmentRetired() {},
            async reload() {},
            async retireInstanceGeneration() {},
            async selectGeneration() {},
            async start() {},
            async stop() {},
            async waitForDrain() {},
        } as never,
        instances: {
            list: () => [],
            onChange: () => () => undefined,
            async stopOwned() {},
        } as never,
        mcp: {
            async prepare() {},
            async start() {},
            status: () => ({ running: false }),
            async stop() {},
        } as never,
        restart: async () => undefined,
        reverse: { service: undefined, stop() {} } as never,
        shutdown: async () => undefined,
        socketPath,
    });
    t.after(async () => await rm(root, { force: true, recursive: true }));

    await assert.rejects(runtime.start(), /missing devshell-extension\.json/iu);
    assert.equal(await ipcEndpointAcceptsConnections(socketPath), false);
});

test("runtime host ingress rewrites unknown instances and leases final generations through dispatch", async (t) => {
    const runtimeDir = await createTestTempDirectory("runtime-toolcall-hooks");
    const socketPath = createTestIpcPath("control-runtime", runtimeDir);
    const listeners = new Set<() => void>();
    const descriptors: Array<{
        approvalReview: () => Promise<{ decision: "continue" }>;
        name: string;
        worker: unknown;
    }> = [];
    const events: string[] = [];
    let reviewDecision: "continue" | "reject" = "continue";
    let targetInstance = "existing";
    let dispatchFailure = false;
    const worker = (name: string) => ({
        toolCallTarget() {
            events.push(`target:${name}`);
            return {
                async dispatch(request: {
                    value: { context: { instance: string } };
                }) {
                    assert.equal(request.value.context.instance, name);
                    events.push(`dispatch:${name}`);
                    await Promise.resolve();
                    assert.equal(events.at(-1), `dispatch:${name}`);
                    if (dispatchFailure) throw new Error("dispatch failed");
                    return { instance: name };
                },
            };
        },
        onCommandSessionClose() {
            return () => undefined;
        },
        onCommandSessionOpen() {
            return () => undefined;
        },
    });
    descriptors.push({
        approvalReview: async () => ({ decision: "continue" as const }),
        name: "existing",
        worker: worker("existing"),
    });

    const extensions = {
        ...testExtensionSurface(),
        listDeclarations(pointId: string) {
            return [
                {
                    declaration: { hook: "500-guard", id: "guard_hook" },
                    id: pointId === "toolcall.review" ? "guard_hook" : "rewrite_hook",
                },
            ];
        },
        async acquireRegistration(pointId: string) {
            return {
                extensionId: "test",
                lease: { release() {} },
                registration: {
                    binding: async (input: {
                        value: { context: { instance: string } };
                        direction: string;
                    }) => {
                        if (pointId === "toolcall.review") {
                            events.push(
                                `review:${input.value.context.instance}`,
                            );
                            return { decision: reviewDecision };
                        }
                        events.push(`rewrite:${input.value.context.instance}`);
                        return {
                            ...input.value,
                            context: {
                                ...input.value.context,
                                instance: targetInstance,
                            },
                        };
                    },
                },
            };
        },
    };
    const instances = {
        get(name: string) {
            assert.equal(name, "nonexistent");
            return descriptors.find((descriptor) => descriptor.name === name);
        },
        acquireGeneration(name: string) {
            events.push(`acquire:${name}`);
            const descriptor = descriptors.find((entry) => entry.name === name);
            assert.ok(descriptor);
            return {
                descriptor,
                release() {
                    events.push(`release:${name}`);
                },
            };
        },
        list() {
            return descriptors;
        },
        onChange(listener: () => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async stopOwned() {},
    };
    const runtime = createControlRuntime({
        contexts: testContexts(
            join("/tmp", `runtime-context-${Date.now()}.json`),
        ),
        configChanges: new ConfigChangeHub(),
        extensionPaths: testExtensionPaths(),
        extensions: extensions as never,
        artifact: { service: undefined, async stop() {} } as never,
        instances: instances as never,
        instanceRuntimes: {
            get(descriptor: { worker: { toolCallTarget(): unknown } }) {
                return {
                    approval: { api: {} },
                    task: { api: { goal: {}, todo: {} } },
                    terminal: { api: {} },
                    tools: {
                        async listTools() { return []; },
                        async readToolCalls() { return []; },
                    },
                    target: () => descriptor.worker.toolCallTarget(),
                    async openToolSession() { throw new Error("Unexpected workspace session."); },
                    async releaseToolSession() {},
                };
            },
            async close() {},
        } as never,
        mcp: {
            async prepare() {},
            async start() {},
            status: () => ({ running: false }),
            async stop() {},
        } as never,
        restart: async () => undefined,
        reverse: { service: undefined, stop() {} } as never,
        shutdown: async () => undefined,
        socketPath,
    });
    t.after(async () => {
        await runtime.stop().catch(() => undefined);
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await runtime.start();
    const endpoint = new Endpoint({
        connectChannel: (signal) =>
            LocalChannel.connect(socketPath, { signal }),
    });
    const service = new ServerSession(
        endpoint,
        createServerTransport(endpoint, { clientKind: "cli" }),
    );
    const tools = createToolTransport(endpoint);
    t.after(() => service.close());
    await service.connect();
    const first = await tools.call("nonexistent", "file_read", {}, "/workspace");
    assert.deepEqual(first, { instance: "existing" });
    assert.deepEqual(events, [
        "review:nonexistent",
        "rewrite:nonexistent",
        "acquire:existing",
        "target:existing",
        "dispatch:existing",
        "release:existing",
    ]);

    events.length = 0;
    reviewDecision = "reject";
    const rejected = (await tools.call(
        "nonexistent",
        "file_read",
        {},
        "/workspace",
    )) as Record<string, JsonValue>;
    assert.equal(rejected.result, null);
    assert.deepEqual(events, ["review:nonexistent"]);

    reviewDecision = "continue";
    descriptors.push({
        approvalReview: async () => ({ decision: "continue" as const }),
        name: "added",
        worker: worker("added"),
    });
    for (const listener of [...listeners]) listener();
    targetInstance = "added";
    events.length = 0;
    assert.deepEqual(
        await tools.call("nonexistent", "file_read", {}, "/workspace"),
        { instance: "added" },
    );
    assert.deepEqual(events, [
        "review:nonexistent",
        "rewrite:nonexistent",
        "acquire:added",
        "target:added",
        "dispatch:added",
        "release:added",
    ]);

    dispatchFailure = true;
    events.length = 0;
    const failed = (await tools.callStreaming(
        "nonexistent",
        "file_read",
        {},
        "/workspace",
    )) as Record<string, JsonValue>;
    assert.equal(failed.result, null);
    assert.equal(
        (failed.error as Record<string, JsonValue>).message,
        "dispatch failed",
    );
    assert.deepEqual(events, [
        "review:nonexistent",
        "rewrite:nonexistent",
        "acquire:added",
        "target:added",
        "dispatch:added",
        "release:added",
    ]);
    service.close();
});
