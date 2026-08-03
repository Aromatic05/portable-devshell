import assert from "node:assert/strict";
import test from "node:test";

import {
    InstanceRegistry,
    McpInstanceGatewayControl,
    createDefaultControlConfig
} from "../../src/testing.ts";

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

test("closing an MCP tool session releases worker-owned session state", async () => {
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
                async releaseToolSession(sessionId: string) {
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

    await gateway.closeToolSession("session-shared");

    assert.deepEqual(released.sort(), [
        "local-one:session-shared",
        "remote-two:session-shared"
    ]);
});

test("MCP instance lifecycle responses preserve active Todo summaries", async () => {
    const activeTodos = [{
        completed: 1,
        currentItem: "Verify release lifecycle",
        revision: 3,
        status: "in_progress" as const,
        taskId: "release-review",
        title: "Release review",
        total: 2
    }];
    const snapshot = {
        connectionState: "disconnected",
        daemonState: "stopped",
        lastSeq: 4,
        name: "remote-server",
        ready: false,
        status: "stopped"
    };
    const registry = new InstanceRegistry([{
        enabled: true,
        mcpCapabilities: ["manage"],
        mcpEnabled: true,
        mcpGroups: ["instance"],
        mcpPath: "/remote-server/mcp",
        name: "remote-server",
        todo: { summaries: () => activeTodos },
        worker: {
            async start() {
                return { ...snapshot, daemonState: "running", ready: true, status: "ready" };
            },
            async stop() {
                return snapshot;
            }
        }
    } as never]);
    const gateway = new McpInstanceGatewayControl({
        createService: {} as never,
        getConfig: () => createDefaultControlConfig(),
        instanceRegistry: registry
    });

    assert.deepEqual(
        (await gateway.startInstance("remote-server") as { activeTodos?: unknown }).activeTodos,
        activeTodos
    );
    assert.deepEqual(
        (await gateway.stopInstance("remote-server") as { activeTodos?: unknown }).activeTodos,
        activeTodos
    );
});
