import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import {
    ControlPathHome,
    createDefaultControlConfig,
    type ControlConfig,
} from "@portable-devshell/shared";

import { McpControlModule } from "../../../../src/server/mcp/Module.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";
import { createToolCallRegistry } from "../../../../src/toolcall/Public.ts";

test("hot enabling and disabling MCP updates status and OAuth approval exposure", async (t) => {
    const homeDirectory = await createTestTempDirectory("mcp-hot-enable-status");
    const approvals = { async list() { return []; } };
    let running = false;
    const status = () => ({
        authMode: "oauth2" as const,
        oauthReady: running,
        publicBaseUrl: "https://mcp.example",
        running,
    });
    const host = {
        oauthApprovals: approvals,
        server: {},
        async start() { running = true; },
        async stop() { running = false; },
        status,
    };
    let config = createDefaultControlConfig();
    const toolRegistry = createToolCallRegistry();
    const runtime = new McpControlModule({
        artifact: { service: {}, installHttpRoute() {} } as never,
        config,
        contextTransport: {} as never,
        controlPaths: new ControlPathHome(homeDirectory),
        factory: {
            wire(next: ControlConfig) {
                return next.mcp.enabled ? host : undefined;
            },
        } as never,
        instances: { list: () => [] } as never,
        toolRegistry,
    });
    t.after(async () => {
        await runtime.stop();
        await rm(homeDirectory, { force: true, recursive: true });
    });

    assert.deepEqual(runtime.status(), {
        reason: "MCP runtime is disabled.",
        running: false,
    });
    assert.equal(runtime.oauthApprovals, undefined);

    const enabled = structuredClone(config);
    enabled.mcp.enabled = true;
    enabled.mcp.oauth2 = { approval: "tui" };
    enabled.mcp.publicBaseUrl = "https://mcp.example";
    await runtime.replaceMcpHost(config, enabled);
    config = enabled;

    assert.equal(runtime.oauthApprovals, approvals);
    assert.deepEqual(runtime.status(), status());
    assert.deepEqual(runtime.oauthApproval, enabled.mcp.oauth2);
    assert.equal(runtime.publicBaseUrl, enabled.mcp.publicBaseUrl);

    const disabled = structuredClone(config);
    disabled.mcp.enabled = false;
    await runtime.replaceMcpHost(config, disabled);

    assert.equal(runtime.oauthApprovals, undefined);
    assert.deepEqual(runtime.status(), {
        reason: "MCP runtime is disabled.",
        running: false,
    });
});
