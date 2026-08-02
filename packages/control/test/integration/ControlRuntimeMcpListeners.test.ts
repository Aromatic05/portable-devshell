import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlPathHome, createDefaultControlConfig, type ControlConfig } from "@portable-devshell/shared";

import { ControlRuntimeMcp } from "../../src/composition/runtime/ControlRuntimeMcp.ts";
import { ControlRuntimeState } from "../../src/composition/runtime/ControlRuntimeState.ts";

test("MCP and Web reuse one listener only when their bind endpoints match", async (t) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-runtime-listener-shared-"));
    const config = createConfig(0, 0);
    const runtime = await createRuntime(config, homeDirectory);
    t.after(async () => {
        await runtime.stop().catch(() => undefined);
        await rm(homeDirectory, { force: true, recursive: true });
    });

    assert.equal(runtime.webHost, runtime.host?.server);
    await runtime.start();
    const address = runtime.webHost?.address;
    assert.ok(typeof address === "object" && address !== null);
    assert.equal(address.port, (runtime.host?.server.address as { port: number }).port);
});

test("separate Web listener can stop without interrupting MCP", async (t) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-runtime-listener-separate-"));
    const runtime = await createRuntime(createConfig(await reservePort(), await reservePort()), homeDirectory);
    t.after(async () => {
        await runtime.stop().catch(() => undefined);
        await rm(homeDirectory, { force: true, recursive: true });
    });

    assert.notEqual(runtime.webHost, runtime.host?.server);
    await runtime.start();
    const address = runtime.host?.server.address;
    assert.ok(typeof address === "object" && address !== null);
    await runtime.webHost?.stop();

    const mcpResponse = await fetch(`http://127.0.0.1:${address.port}/missing/mcp`, { method: "POST" });
    assert.equal(mcpResponse.status, 404);
});

test("replacing an independent Web listener keeps the MCP listener running", async (t) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-runtime-listener-replace-"));
    const config = createConfig(await reservePort(), await reservePort());
    const runtime = await createRuntime(config, homeDirectory);
    t.after(async () => {
        await runtime.stop().catch(() => undefined);
        await rm(homeDirectory, { force: true, recursive: true });
    });
    await runtime.start();
    const mcpAddress = runtime.host?.server.address;
    assert.ok(typeof mcpAddress === "object" && mcpAddress !== null);
    const previousWeb = runtime.webHost;
    const next = structuredClone(config);
    next.web.listenPort = await reservePort();

    const retired = await runtime.replaceWebHost(config, next);
    await runtime.stopRetiredWebHost(retired);

    assert.equal((runtime.host?.server.address as { port: number }).port, mcpAddress.port);
    assert.notEqual(runtime.webHost, previousWeb);
    const mcpResponse = await fetch(`http://127.0.0.1:${mcpAddress.port}/missing/mcp`, { method: "POST" });
    assert.equal(mcpResponse.status, 404);
});

test("replacing an independent MCP listener keeps the Web listener running", async (t) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-runtime-mcp-replace-"));
    const config = createConfig(await reservePort(), await reservePort());
    const runtime = await createRuntime(config, homeDirectory);
    t.after(async () => {
        await runtime.stop().catch(() => undefined);
        await rm(homeDirectory, { force: true, recursive: true });
    });
    await runtime.start();
    const web = runtime.webHost;
    const next = structuredClone(config);
    next.mcp.listenPort = await reservePort();

    const retired = await runtime.replaceMcpHost(next);
    await retired?.stop();

    assert.equal(runtime.webHost, web);
    const address = runtime.webHost?.address;
    assert.ok(typeof address === "object" && address !== null);
    await fetch(`http://127.0.0.1:${address.port}/web/session`, { method: "POST" });
});

test("shared listener Web auth changes use a full runtime rebuild instead of hot replacement", async (t) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-runtime-listener-shared-apply-"));
    const port = await reservePort();
    let config = createConfig(port, port);
    let fullApplyCalls = 0;
    let webHotApplyCalls = 0;
    const state = new ControlRuntimeState({
        configStore: {
            async readOrCreate() {
                return config;
            },
            async write(next: ControlConfig) {
                config = next;
            }
        } as never,
        homeDirectory
    });
    await state.load();
    const runtime = new ControlRuntimeMcp({
        applyRuntimeConfig: async () => {
            fullApplyCalls += 1;
        },
        artifact: {
            service: {},
            installHttpRoute() {}
        } as never,
        controlPaths: new ControlPathHome(homeDirectory),
        state
    });
    runtime.setWebConfigApplier(async () => {
        webHotApplyCalls += 1;
    });
    t.after(async () => {
        await runtime.stop().catch(() => undefined);
        await rm(homeDirectory, { force: true, recursive: true });
    });

    await runtime.configEditor.updateWebConfig({
        patch: { auth: "token", token: "a".repeat(48) }
    });

    assert.equal(fullApplyCalls, 1);
    assert.equal(webHotApplyCalls, 0);
});

async function createRuntime(config: ControlConfig, homeDirectory: string): Promise<ControlRuntimeMcp> {
    const state = new ControlRuntimeState({
        configStore: {
            async readOrCreate() {
                return config;
            }
        } as never,
        homeDirectory
    });
    await state.load();
    return new ControlRuntimeMcp({
        artifact: {
            service: {},
            installHttpRoute() {}
        } as never,
        controlPaths: new ControlPathHome(homeDirectory),
        state
    });
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

async function reservePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    return address.port;
}
