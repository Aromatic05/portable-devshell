import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

import {
    ControlPathHome,
    Endpoint,
    createContextTransport,
    createDefaultControlConfig,
    normalizeConfigInstanceDraft,
    type ControlConfig,
} from "@portable-devshell/shared";

import { McpControlModule } from "../../../src/server/mcp/Module.ts";
import { ControlHttpServer } from "../../../src/server/http/index.ts";
import { ControlServerConfig } from "../../../src/server/Config.ts";
import { ControlWebRuntime } from "../../../src/server/web/Runtime.ts";
import type { ConfigRuntimeChangeSet } from "../../../src/config/engine/Api.ts";
import { ConfigEngine } from "../../../src/config/engine/index.ts";
import { ConfigEditorCoordinator } from "../../../src/config/editor/index.ts";
import { InstanceEditorCoordinator } from "../../../src/instance/editor/index.ts";
import { ControlConfig as ControlConfigOwner } from "../../../src/config/index.ts";
import { ControlInstances } from "../../../src/instance/index.ts";
import { createToolCallRegistry } from "../../../src/toolcall/index.ts";
import { createInstance } from "@portable-devshell/core";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { cleanupInOrder } from "../../../../../test/TestCleanup.ts";

test("MCP and Web reuse one listener only when their bind endpoints match", async (t) => {
    const homeDirectory = await createTestTempDirectory(
        "runtime-listener-shared",
    );
    const config = createConfig(0, 0);
    const runtime = await createRuntime(config, homeDirectory);
    t.after(async () => {
        await cleanupInOrder(
            () => runtime.stop(),
            () => rm(homeDirectory, { force: true, recursive: true }),
        );
    });

    await runtime.start();
    const address = runtime.mcp.host?.server.address;
    assert.ok(typeof address === "object" && address !== null);
    assert.equal(
        address.port,
        (runtime.mcp.host?.server.address as { port: number }).port,
    );
    const response = await fetch(`http://127.0.0.1:${address.port}/web/session`, { method: "POST" });
    assert.equal(response.status, 200);
});

test("MCP startup does not parse provenance history before the listener is ready", async (t) => {
    const homeDirectory = await createTestTempDirectory(
        "runtime-provenance-lazy-start",
    );
    const config = createDefaultControlConfig();
    config.mcp.enabled = true;
    config.mcp.listenHost = "127.0.0.1";
    config.mcp.listenPort = 0;
    config.mcp.publicBaseUrl = "http://127.0.0.1";
    const paths = new ControlPathHome(homeDirectory);
    await mkdir(join(paths.controlHomeDir, "audit"), { recursive: true });
    await writeFile(paths.toolProvenanceFile, "{invalid provenance\n", "utf8");
    const runtime = await createRuntime(config, homeDirectory);
    t.after(async () => {
        await cleanupInOrder(
            () => runtime.stop(),
            () => rm(homeDirectory, { force: true, recursive: true }),
        );
    });

    await runtime.start();
    const address = runtime.mcp.host?.server.address;
    assert.ok(typeof address === "object" && address !== null);
});

test("separate Web listener can stop without interrupting MCP", async (t) => {
    const homeDirectory = await createTestTempDirectory(
        "runtime-listener-separate",
    );
    const runtime = await createRuntime(
        await createIndependentConfig(),
        homeDirectory,
    );
    t.after(async () => {
        await cleanupInOrder(
            () => runtime.stop(),
            () => rm(homeDirectory, { force: true, recursive: true }),
        );
    });

    assert.ok(runtime.web.listener);
    await runtime.start();
    const address = runtime.mcp.host?.server.address;
    assert.ok(typeof address === "object" && address !== null);
    await runtime.web.stopHost();

    const mcpResponse = await fetch(
        `http://127.0.0.1:${address.port}/missing/mcp`,
        { method: "POST" },
    );
    assert.equal(mcpResponse.status, 404);
});

test("replacing an independent Web listener keeps the MCP listener running", async (t) => {
    const homeDirectory = await createTestTempDirectory(
        "runtime-listener-replace",
    );
    const config = await createIndependentConfig();
    const runtime = await createRuntime(config, homeDirectory);
    t.after(async () => {
        await cleanupInOrder(
            () => runtime.stop(),
            () => rm(homeDirectory, { force: true, recursive: true }),
        );
    });
    await runtime.start();
    const mcpAddress = runtime.mcp.host?.server.address;
    assert.ok(typeof mcpAddress === "object" && mcpAddress !== null);
    const previousWeb = runtime.web.listener;
    const next = structuredClone(config);

    await runtime.web.replace(config, next, {
        async replaceListener(previous, replacement) {
            await previous.close();
            await replacement.start(() => undefined);
        },
    });

    assert.equal(
        (runtime.mcp.host?.server.address as { port: number }).port,
        mcpAddress.port,
    );
    assert.notEqual(runtime.web.listener, previousWeb);
    const mcpResponse = await fetch(
        `http://127.0.0.1:${mcpAddress.port}/missing/mcp`,
        { method: "POST" },
    );
    assert.equal(mcpResponse.status, 404);
});

test("replacing an independent MCP listener keeps the Web listener running", async (t) => {
    const homeDirectory = await createTestTempDirectory("runtime-mcp-replace");
    const config = await createIndependentConfig();
    const runtime = await createRuntime(config, homeDirectory);
    t.after(async () => {
        await cleanupInOrder(
            () => runtime.stop(),
            () => rm(homeDirectory, { force: true, recursive: true }),
        );
    });
    await runtime.start();
    const web = runtime.web.listener;
    const next = structuredClone(config);

    const retired = await runtime.mcp.replaceMcpHost(config, next);
    await retired?.stop();

    assert.equal(runtime.web.listener, web);
    const response = await fetch(`http://127.0.0.1:${config.web.listenPort}/web/session`, {
        method: "POST",
    });
    assert.equal(response.status, 200);
});

test("instance MCP auth updates do not replace an unrelated Web listener", async (t) => {
    const homeDirectory = await createTestTempDirectory(
        "runtime-instance-auth",
    );
    let config = await createIndependentConfig();
    config.instances = [
        normalizeConfigInstanceDraft({
            mcp: { contextMode: "explicit" },
            name: "demo-local",
            provider: "local",
        }),
    ];
    const owners = await createOwners(config, homeDirectory, {
        async readOrCreate() {
            return config;
        },
        async write(next: ControlConfig) {
            config = next;
        },
    });
    const runtime = new McpControlModule({
        http: new ControlHttpServer(),
        config: owners.config.require(),
        context: createContextTransport(new Endpoint({ host: "listener-test" })),
        instances: owners.instances.registry,
        toolRegistry: owners.toolRegistry,
        controlPaths: new ControlPathHome(homeDirectory),
    });
    const serverConfig = new ControlServerConfig({
        mcp: runtime,
        replaceHttpRoutes: async () => undefined,
        transport: {} as never,
        web: {} as never,
    });
    t.after(async () => {
        await cleanupInOrder(
            () => runtime.stop(),
            () => rm(homeDirectory, { force: true, recursive: true }),
        );
    });

    const { instanceEditor } = createEditors(
        owners,
        runtime,
        serverConfig.apply.bind(serverConfig),
    );
    const result = (await instanceEditor.updateInstanceConfig({
        instanceName: "demo-local",
        patch: { mcp: { auth: "token", token: "a".repeat(48) } },
    })) as { restartControlRequired: boolean };

    assert.equal(result.restartControlRequired, false);
});

test("enabling MCP hot-applies the listener without requiring Control restart", async (t) => {
    const homeDirectory = await createTestTempDirectory("runtime-mcp-enable");
    let config = createDefaultControlConfig();
    config.mcp.listenPort = 0;
    config.web.enabled = false;
    const owners = await createOwners(config, homeDirectory, {
        async readOrCreate() {
            return config;
        },
        async write(next: ControlConfig) {
            config = next;
        },
    });
    const runtime = new McpControlModule({
        http: new ControlHttpServer(),
        config: owners.config.require(),
        context: createContextTransport(new Endpoint({ host: "listener-test" })),
        instances: owners.instances.registry,
        toolRegistry: owners.toolRegistry,
        controlPaths: new ControlPathHome(homeDirectory),
    });
    const serverConfig = new ControlServerConfig({
        mcp: runtime,
        replaceHttpRoutes: async () => undefined,
        transport: {} as never,
        web: {} as never,
    });
    t.after(async () => {
        await cleanupInOrder(
            () => runtime.stop(),
            () => rm(homeDirectory, { force: true, recursive: true }),
        );
    });

    const { configEditor } = createEditors(
        owners,
        runtime,
        serverConfig.apply.bind(serverConfig),
    );
    const result = (await configEditor.updateMcpConfig({
        patch: { enabled: true },
    })) as { restartControlRequired: boolean };

    assert.equal(result.restartControlRequired, false);
    assert.ok(runtime.host);
});

test("Control HTTP route replacement failure restores both MCP and business routes", async () => {
    const previous = createConfig(17888, 17889);
    previous.web.enabled = false;
    const next = structuredClone(previous);
    next.mcp.publicBaseUrl = "https://new-endpoint.example";
    const events: string[] = [];
    const retired = { async stop() {} };
    const mcp = {
        async replaceMcpHost() { events.push("mcp.replace"); return retired; },
        async restoreMcpHost(host: unknown, config: ControlConfig) {
            assert.equal(host, retired);
            assert.equal(config, previous);
            events.push("mcp.restore");
        },
        async stopHost() { events.push("mcp.stop-retired"); },
    };
    const serverConfig = new ControlServerConfig({
        mcp: mcp as never,
        replaceHttpRoutes: async (config) => {
            if (config === next) {
                events.push("routes.replace");
                throw new Error("route registration failed");
            }
            assert.equal(config, previous);
            events.push("routes.restore");
        },
        transport: {} as never,
        web: {} as never,
    });
    await assert.rejects(
        serverConfig.apply(previous, next, { instanceAuth: false, mcp: true, web: false }),
        /route registration failed/u,
    );
    assert.deepEqual(events, [
        "mcp.replace", "routes.replace", "mcp.restore", "routes.restore",
    ]);
});

test("MCP migration starts a different listener before retiring the previous listener", async (t) => {
    const homeDirectory = await createTestTempDirectory("runtime-mcp-order");
    const previous = createConfig(17890, 17891);
    previous.web.enabled = false;
    const next = structuredClone(previous);
    next.mcp.listenPort = 17892;
    next.mcp.publicBaseUrl = "https://new.example";
    const events: string[] = [];
    const oldHost = {
        server: {},
        async start() {
            events.push("old.start");
        },
        async stop() {
            events.push("old.stop");
        },
    };
    const newHost = {
        server: {},
        async start() {
            events.push("new.start");
        },
        async stop() {
            events.push("new.stop");
        },
    };
    let wireCalls = 0;
    const owners = await createOwners(previous, homeDirectory);
    const runtime = new McpControlModule({
        http: new ControlHttpServer(),
        config: owners.config.require(),
        context: createContextTransport(new Endpoint({ host: "listener-test" })),
        instances: owners.instances.registry,
        toolRegistry: owners.toolRegistry,
        controlPaths: new ControlPathHome(homeDirectory),
        factory: {
            wire() {
                wireCalls += 1;
                return wireCalls === 1 ? oldHost : newHost;
            },
        } as never,
    });
    t.after(
        async () => await rm(homeDirectory, { force: true, recursive: true }),
    );

    owners.config.set(next);
    const retired = await runtime.replaceMcpHost(previous, next);
    assert.deepEqual(events, ["new.start"]);
    assert.equal(runtime.publicBaseUrl, "https://new.example");
    await retired?.stop();
    assert.deepEqual(events, ["new.start", "old.stop"]);
});

test("MCP same-endpoint replacement reports both startup and rollback failures", async (t) => {
    const homeDirectory = await createTestTempDirectory(
        "runtime-mcp-rollback-failure",
    );
    const previous = createConfig(17893, 17894);
    previous.web.enabled = false;
    const next = structuredClone(previous);
    next.mcp.publicBaseUrl = "https://replacement.example";
    const events: string[] = [];
    const oldHost = {
        server: {},
        async start() {
            events.push("old.start");
            throw new Error("old restart failed");
        },
        async stop() {
            events.push("old.stop");
        },
    };
    const newHost = {
        server: {},
        async start() {
            events.push("new.start");
            throw new Error("new start failed");
        },
        async stop() {
            events.push("new.stop");
        },
        async dispose() {
            events.push("new.dispose");
        },
    };
    let wireCalls = 0;
    const owners = await createOwners(previous, homeDirectory);
    const runtime = new McpControlModule({
        http: new ControlHttpServer(),
        config: owners.config.require(),
        context: createContextTransport(new Endpoint({ host: "listener-test" })),
        instances: owners.instances.registry,
        toolRegistry: owners.toolRegistry,
        controlPaths: new ControlPathHome(homeDirectory),
        factory: {
            wire() {
                wireCalls += 1;
                return wireCalls === 1 ? oldHost : newHost;
            },
        } as never,
    });
    t.after(
        async () => await rm(homeDirectory, { force: true, recursive: true }),
    );

    await assert.rejects(
        runtime.replaceMcpHost(previous, next),
        (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(
                error.errors.map((entry) => (entry as Error).message),
                ["new start failed", "old restart failed"],
            );
            return true;
        },
    );
    assert.deepEqual(events, ["old.stop", "new.start", "new.dispose", "old.start"]);
});

test("MCP stop failure disposes the uncommitted Host and restores the previous Host", async (t) => {
    const homeDirectory = await createTestTempDirectory("runtime-mcp-stop-rollback");
    const previous = createConfig(17893, 17894);
    previous.web.enabled = false;
    const next = structuredClone(previous);
    next.mcp.publicBaseUrl = "https://replacement.example";
    const events: string[] = [];
    let failStop = true;
    const oldHost = {
        async start() { events.push("old.start"); },
        async stop() {
            events.push("old.stop");
            if (failStop) { failStop = false; throw new Error("old stop failed"); }
        },
    };
    const newHost = {
        async start() { events.push("new.start"); },
        async stop() { events.push("new.stop"); },
        async dispose() { events.push("new.dispose"); },
    };
    let wires = 0;
    const owners = await createOwners(previous, homeDirectory);
    const runtime = new McpControlModule({
        http: new ControlHttpServer(),
        config: owners.config.require(),
        context: createContextTransport(new Endpoint({ host: "listener-test" })),
        instances: owners.instances.registry,
        toolRegistry: owners.toolRegistry,
        controlPaths: new ControlPathHome(homeDirectory),
        factory: { wire() { return ++wires === 1 ? oldHost : newHost; } } as never,
    });
    t.after(async () => await cleanupInOrder(
        () => runtime.stop(),
        () => rm(homeDirectory, { force: true, recursive: true }),
    ));

    await assert.rejects(runtime.replaceMcpHost(previous, next), /old stop failed/u);
    assert.deepEqual(events, ["old.stop", "new.dispose", "old.start"]);
    assert.equal(runtime.host, oldHost);
    assert.equal(runtime.publicBaseUrl, previous.mcp.publicBaseUrl);
});

test("retired MCP cleanup failure does not reject an already committed replacement", async (t) => {
    const previous = createConfig(17888, 17889);
    previous.web.enabled = false;
    const next = structuredClone(previous);
    next.mcp.publicBaseUrl = "https://replacement.example";
    const events: string[] = [];
    const retired = {
        async dispose() { events.push("retired.dispose"); throw new Error("cleanup failed"); },
    };
    const mcp = {
        host: {},
        async replaceMcpHost() { events.push("mcp.replace"); return retired; },
        async stopHost() { events.push("retired.stop"); },
        async restoreMcpHost() { events.push("mcp.restore"); },
    };
    const warning = t.mock.method(console, "warn", () => undefined);
    const serverConfig = new ControlServerConfig({
        mcp: mcp as never,
        replaceHttpRoutes: async () => { events.push("routes.replace"); },
        transport: {} as never,
        web: {} as never,
    });
    assert.equal(await serverConfig.apply(previous, next, { instanceAuth: false, mcp: true, web: false }), true);
    assert.deepEqual(events, ["mcp.replace", "routes.replace", "retired.stop", "retired.dispose"]);
    assert.equal(warning.mock.callCount(), 1);
});

test("retired MCP stop failure never rolls back the active replacement", async (t) => {
    const previous = createConfig(17888, 17889);
    previous.web.enabled = false;
    const next = structuredClone(previous);
    next.mcp.publicBaseUrl = "https://replacement.example";
    const events: string[] = [];
    const retired = { async dispose() { events.push("old.dispose"); } };
    const mcp = {
        host: {},
        async replaceMcpHost() { events.push("replace"); return retired; },
        async stopHost() { events.push("old.stop"); throw new Error("old stop failed"); },
        async restoreMcpHost() { events.push("restore"); },
    };
    const warning = t.mock.method(console, "warn", () => undefined);
    const config = new ControlServerConfig({
        mcp: mcp as never,
        replaceHttpRoutes: async () => { events.push("routes"); },
        transport: {} as never,
        web: {} as never,
    });
    assert.equal(await config.apply(previous, next, { instanceAuth: false, mcp: true, web: false }), true);
    assert.deepEqual(events, ["replace", "routes", "old.stop", "old.dispose"]);
    assert.equal(warning.mock.callCount(), 1);
});

test("MCP restore attempts every host transition and reports rollback failures", async (t) => {
    const homeDirectory = await createTestTempDirectory(
        "runtime-mcp-restore-failure",
    );
    const previous = createConfig(17895, 17896);
    previous.web.enabled = false;
    const next = structuredClone(previous);
    next.mcp.listenPort = 17897;
    next.mcp.publicBaseUrl = "https://new-restore.example";
    const events: string[] = [];
    let oldStartShouldFail = false;
    let newStopShouldFail = false;
    const oldHost = {
        server: {},
        async start() {
            events.push("old.start");
            if (oldStartShouldFail) throw new Error("old restore failed");
        },
        async stop() {
            events.push("old.stop");
        },
    };
    const newHost = {
        server: {},
        async start() {
            events.push("new.start");
        },
        async stop() {
            events.push("new.stop");
            if (newStopShouldFail) throw new Error("new stop failed");
        },
    };
    let wireCalls = 0;
    const owners = await createOwners(previous, homeDirectory);
    const runtime = new McpControlModule({
        http: new ControlHttpServer(),
        config: owners.config.require(),
        context: createContextTransport(new Endpoint({ host: "listener-test" })),
        instances: owners.instances.registry,
        toolRegistry: owners.toolRegistry,
        controlPaths: new ControlPathHome(homeDirectory),
        factory: {
            wire() {
                wireCalls += 1;
                return wireCalls === 1 ? oldHost : newHost;
            },
        } as never,
    });
    t.after(
        async () => await rm(homeDirectory, { force: true, recursive: true }),
    );

    owners.config.set(next);
    const retired = await runtime.replaceMcpHost(previous, next);
    assert.equal(retired, oldHost);
    oldStartShouldFail = true;
    newStopShouldFail = true;

    await assert.rejects(
        runtime.restoreMcpHost(oldHost as never, previous),
        (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(
                error.errors.map((entry) => (entry as Error).message),
                ["new stop failed", "old restore failed"],
            );
            return true;
        },
    );
    assert.deepEqual(events, ["new.start", "new.stop", "old.start"]);
});

test("Web same-endpoint replacement reports both startup and rollback bind failures", async (t) => {
    const homeDirectory = await createTestTempDirectory(
        "runtime-web-rollback-failure",
    );
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
        occupied.once("error", reject);
        occupied.listen(0, "127.0.0.1", () => resolve());
    });
    const address = occupied.address();
    assert.ok(typeof address === "object" && address !== null);
    const config = await createIndependentConfig();
    config.web.listenHost = "127.0.0.1";
    config.web.listenPort = address.port;
    const owners = await createOwners(config, homeDirectory);
    const runtime = new McpControlModule({
        http: new ControlHttpServer(),
        config: owners.config.require(),
        context: createContextTransport(new Endpoint({ host: "listener-test" })),
        instances: owners.instances.registry,
        toolRegistry: owners.toolRegistry,
        controlPaths: new ControlPathHome(homeDirectory),
    });
    t.after(async () => {
        await cleanupInOrder(
            () =>
                new Promise<void>((resolve, reject) =>
                    occupied.close((error) =>
                        error === undefined ? resolve() : reject(error),
                    ),
                ),
            () => rm(homeDirectory, { force: true, recursive: true }),
        );
    });

    const web = createWeb(config, homeDirectory, runtime);
    t.after(async () => { web.stop(); await runtime.stop(); });
    await assert.rejects(
        web.replace(config, structuredClone(config), { async replaceListener() {} }),
        (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.equal(error.errors.length, 2);
            assert.equal(
                error.errors.every(
                    (entry) =>
                        (entry as NodeJS.ErrnoException).code === "EADDRINUSE",
                ),
                true,
            );
            return true;
        },
    );
});

test("Web same-endpoint stop failure disposes the new HTTP Lease and restores the old listener", async (t) => {
    const homeDirectory = await createTestTempDirectory("runtime-web-stop-rollback");
    const config = await createIndependentConfig();
    config.web.listenHost = "127.0.0.1";
    const owners = await createOwners(config, homeDirectory);
    const mcp = new McpControlModule({
        http: new ControlHttpServer(),
        config: owners.config.require(),
        context: createContextTransport(new Endpoint({ host: "listener-test" })),
        instances: owners.instances.registry,
        toolRegistry: owners.toolRegistry,
        controlPaths: new ControlPathHome(homeDirectory),
    });
    const http = new ControlHttpServer();
    const acquire = http.acquire.bind(http);
    let calls = 0;
    let nextDisposed = false;
    http.acquire = (address) => {
        const lease = acquire(address);
        calls += 1;
        if (calls === 1) {
            const stop = lease.stop.bind(lease);
            let failOnce = true;
            lease.stop = async () => {
                await stop();
                if (failOnce) { failOnce = false; throw new Error("old HTTP stop failed"); }
            };
        } else {
            const dispose = lease.dispose.bind(lease);
            lease.dispose = async () => { nextDisposed = true; await dispose(); };
        }
        return lease;
    };
    const web = createWeb(config, homeDirectory, mcp, http);
    t.after(async () => await cleanupInOrder(
        () => web.listener?.close(),
        () => { web.stop(); },
        () => web.stopHost(),
        () => mcp.stop(),
        () => http.close(),
        () => rm(homeDirectory, { force: true, recursive: true }),
    ));
    await web.prepare();
    await web.listener?.start(() => undefined);
    await web.startHost();
    await assert.rejects(
        web.replace(config, structuredClone(config), { async replaceListener() {} }),
        /old HTTP stop failed/u,
    );
    assert.equal(nextDisposed, true);
    const response = await fetch(`http://127.0.0.1:${config.web.listenPort}/web/session`, { method: "POST" });
    assert.equal(response.status, 200);
});

test("shared listener Web auth changes require an explicit control restart without stopping the current runtime", async (t) => {
    const homeDirectory = await createTestTempDirectory(
        "runtime-listener-shared-apply",
    );
    let config = createConfig(0, 0);
    const owners = await createOwners(config, homeDirectory, {
        async readOrCreate() {
            return config;
        },
        async write(next: ControlConfig) {
            config = next;
        },
    });
    const runtime = new McpControlModule({
        http: new ControlHttpServer(),
        config: owners.config.require(),
        context: createContextTransport(new Endpoint({ host: "listener-test" })),
        instances: owners.instances.registry,
        toolRegistry: owners.toolRegistry,
        controlPaths: new ControlPathHome(homeDirectory),
    });
    const serverConfig = new ControlServerConfig({
        mcp: runtime,
        replaceHttpRoutes: async () => undefined,
        transport: {} as never,
        web: {} as never,
    });
    t.after(async () => {
        await cleanupInOrder(
            () => runtime.stop(),
            () => rm(homeDirectory, { force: true, recursive: true }),
        );
    });

    const { configEditor } = createEditors(
        owners,
        runtime,
        serverConfig.apply.bind(serverConfig),
    );
    const previousHost = runtime.host;
    const result = (await configEditor.updateWebConfig({
        patch: { auth: "token", token: "a".repeat(48) },
    })) as {
        restartControlRequired: boolean;
    };

    assert.equal(result.restartControlRequired, true);
    assert.equal(runtime.host, previousHost);
    const view = configEditor.getConfigView() as {
        restartControlRequired?: boolean;
    };
    assert.equal(view.restartControlRequired, true);
});

function createWeb(config: ControlConfig, homeDirectory: string, mcp: McpControlModule, http = new ControlHttpServer()): ControlWebRuntime {
    return new ControlWebRuntime({
        config,
        http,
        extensions: {
            generationDirectory: () => "",
        } as never,
        mcp,
        oauthDirectory: join(new ControlPathHome(homeDirectory).oauthDir, "web"),
    });
}

async function createRuntime(config: ControlConfig, homeDirectory: string) {
    const owners = await createOwners(config, homeDirectory);
    const endpoint = new Endpoint({ host: "listener-test" });
    const http = new ControlHttpServer();
    const mcp = new McpControlModule({
        http,
        config, context: createContextTransport(endpoint), instances: owners.instances.registry, toolRegistry: owners.toolRegistry,
        controlPaths: new ControlPathHome(homeDirectory),
    });
    const web = createWeb(config, homeDirectory, mcp, http);
    return {
        mcp, web,
        async start() {
            await web.prepare();
            await web.listener?.start(() => undefined);
            await mcp.start();
            await web.startHost();
        },
        async stop() {
            await cleanupInOrder(
                () => web.listener?.close(),
                () => { web.stop(); },
                () => web.stopHost(),
                () => mcp.stop(),
                () => http.close(),
                () => { endpoint.close(); },
                () => owners.close(),
            );
        },
    };
}

function createEditors(
    owners: TestOwners,
    mcp: McpControlModule,
    applyRuntimeConfig: (
        previous: ControlConfig,
        next: ControlConfig,
        changes: ConfigRuntimeChangeSet,
    ) => Promise<boolean>,
) {
    const options = {
        configStore: owners.config.store,
        getConfig: () => owners.config.require(),
        getRestartControlRequired: () => owners.config.restartRequired,
        markRestartControlRequired: () => owners.config.markRestartRequired(),
        homeDirectory: owners.homeDirectory,
        changeHub: owners.config.changes,
        mutationRunner: owners.config.mutations,
        registry: owners.config.registry,
        runtimeApply: { apply: applyRuntimeConfig },
        setConfig: (config: ControlConfig) => owners.config.set(config),
    };
    const engine = new ConfigEngine(options);
    const instanceEditor = new InstanceEditorCoordinator({
        engine,
        instanceRegistry: owners.instances.registry,
        instanceChanges: owners.instances.changes,
        createRuntimeInstance: (config) => createInstance(config),
        finalizeRuntimeInstance: async (instance) => await instance.close(),
        mcp: mcp.instancePort,
    });
    const configEditor = new ConfigEditorCoordinator({
        engine,
        instances: instanceEditor,
    });
    return { instanceEditor, configEditor };
}

interface TestOwners {
    config: ControlConfigOwner;
    homeDirectory: string;
    instances: ControlInstances;
    toolRegistry: ReturnType<typeof createToolCallRegistry>;
    close(): Promise<void>;
}

async function createOwners(
    initialConfig: ControlConfig,
    homeDirectory: string,
    store?: {
        readOrCreate(): Promise<ControlConfig>;
        write?(next: ControlConfig): Promise<void>;
    },
): Promise<TestOwners> {
    const config = new ControlConfigOwner({
        store: (store ?? {
            async readOrCreate() {
                return initialConfig;
            },
            async write() {},
        }) as never,
    });
    await config.load(homeDirectory);
    const instances = new ControlInstances();
    config.changes.onChange((change) => {
        if (
            change.paths.some(
                (path) =>
                    path === "instances" || path.startsWith("instances."),
            )
        ) {
            instances.changes.publish("config");
        }
    });
    await instances.load(config.require());
    const toolRegistry = createToolCallRegistry();
    return {
        config,
        homeDirectory,
        instances,
        toolRegistry,
        async close() {
            await instances.close();
        },
    };
}

async function availablePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return address.port;
}

function createConfig(mcpPort: number, webPort: number): ControlConfig {
    const config = createDefaultControlConfig();
    config.mcp.enabled = true;
    config.mcp.listenHost = "127.0.0.1";
    config.mcp.listenPort = mcpPort;
    config.mcp.publicBaseUrl = "http://127.0.0.1";
    config.web.enabled = true;
    config.web.listenHost = "127.0.0.1";
    config.web.listenPort = webPort;
    config.web.publicBaseUrl = "http://127.0.0.1";
    return config;
}

async function createIndependentConfig(): Promise<ControlConfig> {
    const config = createConfig(0, 0);
    config.web.listenHost = "0.0.0.0";
    config.web.listenPort = await availablePort();
    return config;
}
