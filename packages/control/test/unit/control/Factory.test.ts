import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createDefaultControlConfig } from "@portable-devshell/shared";
import { ControlFactory, resolveControlExtensionAssetLimits } from "../../../src/Factory.ts";
import { ControlConfig } from "../../../src/config/index.ts";
import { ControlInstances } from "../../../src/instance/index.ts";
import { McpRuntimeFactory } from "../../../src/server/mcp/Runtime.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

test("Control grants the reserved Agent Extension a bounded large-Provider asset budget only", () => {
    assert.equal(resolveControlExtensionAssetLimits("artifact"), undefined);
    assert.equal(resolveControlExtensionAssetLimits("skill"), undefined);
    assert.deepEqual(resolveControlExtensionAssetLimits("agent"), {
        maxCompressedBytes: 128 * 1024 * 1024,
        maxFileBytes: 256 * 1024 * 1024,
        maxLogicalBytes: 512 * 1024 * 1024,
    });
});

test("Control Factory releases an acquired HTTP Lease when MCP construction fails", async () => {
    const homeDirectory = await createTestTempDirectory("control-factory-mcp-failure");
    const config = new ControlConfig();
    const document = createDefaultControlConfig();
    document.mcp.enabled = true;
    document.mcp.listenHost = "127.0.0.1";
    document.mcp.listenPort = 0;
    document.web.enabled = false;
    config.set(document);
    const instances = new ControlInstances();
    const production = new McpRuntimeFactory();
    let acquired: { start(): Promise<void> } | undefined;
    const factory = new ControlFactory({
        builtinExtensionSources: [],
        mcpFactory: {
            wire(...args: Parameters<McpRuntimeFactory["wire"]>) {
                acquired = production.wire(...args)?.server;
                throw new Error("MCP construction failed");
            },
        } as never,
    });
    try {
        await assert.rejects(factory.create({
            config, homeDirectory, instances,
            socketPath: join(homeDirectory, "control.sock"),
            restart: async () => {}, shutdown: async () => {},
        }), /MCP construction failed/u);
        assert.ok(acquired);
        await assert.rejects(acquired.start(), /disposed/u);
    } finally {
        await instances.close();
        await rm(homeDirectory, { recursive: true, force: true });
    }
});

test("Control Factory closes composed MCP and HTTP owners if runtime attachment fails", async () => {
    const homeDirectory = await createTestTempDirectory("control-factory-attach-failure");
    const config = new ControlConfig();
    const document = createDefaultControlConfig();
    document.mcp.enabled = true;
    document.mcp.listenHost = "127.0.0.1";
    document.mcp.listenPort = 0;
    document.web.enabled = false;
    config.set(document);
    const instances = new ControlInstances();
    instances.attachRuntime = () => { throw new Error("runtime attachment failed"); };
    const production = new McpRuntimeFactory();
    let acquired: { start(): Promise<void> } | undefined;
    const factory = new ControlFactory({
        builtinExtensionSources: [],
        mcpFactory: {
            wire(...args: Parameters<McpRuntimeFactory["wire"]>) {
                const host = production.wire(...args);
                acquired = host?.server;
                return host;
            },
        } as never,
    });
    try {
        await assert.rejects(factory.create({
            config, homeDirectory, instances,
            socketPath: join(homeDirectory, "control.sock"),
            restart: async () => {}, shutdown: async () => {},
        }), /runtime attachment failed/u);
        assert.ok(acquired);
        await assert.rejects(acquired.start(), /disposed/u);
    } finally {
        await instances.close();
        await rm(homeDirectory, { recursive: true, force: true });
    }
});
