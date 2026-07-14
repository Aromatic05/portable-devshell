import assert from "node:assert/strict";
import test from "node:test";

import {
    InstanceRegistry,
    McpInstanceGatewayControl,
    createDefaultControlConfig
} from "../../dist/index.js";

function createGateway(ready: boolean): McpInstanceGatewayControl {
    const registry = new InstanceRegistry([
        {
            enabled: true,
            mcpCapabilities: ["read", "write", "execute"],
            mcpEnabled: true,
            mcpGroups: ["file", "bash", "artifact"],
            mcpPath: "/remote-server/mcp",
            name: "remote-server",
            worker: {
                snapshot() {
                    return { ready };
                }
            }
        } as never
    ]);

    return new McpInstanceGatewayControl({
        createService: {} as never,
        getConfig: () => createDefaultControlConfig(),
        instanceRegistry: registry
    });
}

test("cross-instance readiness check reports core.instanceNotReady before schema lookup", () => {
    const gateway = createGateway(false);

    assert.throws(
        () => gateway.assertReady("remote-server"),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "core.instanceNotReady");
            assert.deepEqual((error as { details?: unknown }).details, {
                instance: "remote-server"
            });
            return true;
        }
    );
});

test("cross-instance readiness check accepts a ready target", () => {
    const gateway = createGateway(true);

    assert.doesNotThrow(() => gateway.assertReady("remote-server"));
});

test("closing an MCP file session releases snapshots on every managed worker", async () => {
    const released: string[] = [];
    const registry = new InstanceRegistry(
        ["local-one", "remote-two"].map((name) => ({
            enabled: true,
            mcpCapabilities: ["read", "write"],
            mcpEnabled: true,
            mcpGroups: ["file"],
            mcpPath: `/${name}/mcp`,
            name,
            worker: {
                async releaseFileSession(sessionId: string) {
                    released.push(`${name}:${sessionId}`);
                }
            }
        })) as never
    );
    const gateway = new McpInstanceGatewayControl({
        createService: {} as never,
        getConfig: () => createDefaultControlConfig(),
        instanceRegistry: registry
    });

    await gateway.closeFileSession("session-shared");

    assert.deepEqual(released.sort(), [
        "local-one:session-shared",
        "remote-two:session-shared"
    ]);
});
