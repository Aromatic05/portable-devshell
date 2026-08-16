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

test("cross-instance audit is recorded by the target worker", async () => {
    const calls: Array<{ context: unknown; input: unknown; toolName: string }> = [];
    const registry = new InstanceRegistry([{
        enabled: true,
        mcpCapabilities: ["read"],
        mcpEnabled: true,
        mcpGroups: ["artifact"],
        mcpPath: "/remote-server/mcp",
        name: "remote-server",
        worker: {
            async auditToolCall(toolName: string, input: unknown, context: unknown, operation: (callId: string) => Promise<unknown>) {
                calls.push({ context, input, toolName });
                return await operation("remote-call");
            }
        }
    } as never]);
    const gateway = new McpInstanceGatewayControl({
        createService: {} as never,
        getConfig: () => createDefaultControlConfig(),
        instanceRegistry: registry
    });

    const result = await gateway.auditToolCall(
        "remote-server",
        "artifact_viewImage",
        { path: "./preview.png" },
        { ctxId: "ctx-remote", source: "mcp", workspace: "/projects/remote" },
        async (callId) => ({ callId })
    );

    assert.deepEqual(result, { callId: "remote-call" });
    assert.deepEqual(calls, [{
        context: { ctxId: "ctx-remote", source: "mcp", workspace: "/projects/remote" },
        input: { path: "./preview.png" },
        toolName: "artifact_viewImage"
    }]);
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
    let currentSnapshot = snapshot;
    let startCalls = 0;
    const registry = new InstanceRegistry([{
        enabled: true,
        mcpCapabilities: ["manage"],
        mcpEnabled: true,
        mcpGroups: ["instance"],
        mcpPath: "/remote-server/mcp",
        name: "remote-server",
        todo: { summaries: () => activeTodos },
        worker: {
            managementMode: "controllerManaged",
            snapshot() {
                return currentSnapshot;
            },
            async start() {
                startCalls += 1;
                currentSnapshot = { ...snapshot, daemonState: "running", ready: true, status: "ready" };
                return currentSnapshot;
            },
            async stop() {
                currentSnapshot = snapshot;
                return currentSnapshot;
            }
        }
    } as never]);
    const gateway = new McpInstanceGatewayControl({
        createService: {} as never,
        getConfig: () => createDefaultControlConfig(),
        instanceRegistry: registry
    });

    assert.deepEqual(
        (await gateway.connectInstance("remote-server", "ctx-one") as { activeTodos?: unknown }).activeTodos,
        activeTodos
    );
    await gateway.connectInstance("remote-server", "ctx-one");
    assert.equal(startCalls, 1);
    assert.deepEqual(
        (await gateway.stopInstance("remote-server") as { activeTodos?: unknown }).activeTodos,
        activeTodos
    );
});

test("MCP instance connect lifecycle uses Context references without adopting an already-ready worker", async () => {
    let ready = false;
    let startCalls = 0;
    let stopCalls = 0;
    const registry = new InstanceRegistry([{
        enabled: true,
        mcpCapabilities: ["manage"],
        mcpEnabled: true,
        mcpGroups: ["instance"],
        mcpPath: "/managed/mcp",
        name: "managed",
        todo: { summaries: () => [] },
        worker: {
            managementMode: "controllerManaged",
            snapshot: () => ({ ready }),
            async start() {
                startCalls += 1;
                ready = true;
                return { ready: true };
            },
            async stop() {
                stopCalls += 1;
                ready = false;
                return { ready: false };
            }
        }
    } as never, {
        enabled: true,
        mcpCapabilities: ["manage"],
        mcpEnabled: true,
        mcpGroups: ["instance"],
        mcpPath: "/external/mcp",
        name: "external",
        todo: { summaries: () => [] },
        worker: {
            managementMode: "controllerManaged",
            snapshot: () => ({ ready: true }),
            async stop() {
                stopCalls += 100;
                return { ready: false };
            }
        }
    } as never]);
    const gateway = new McpInstanceGatewayControl({
        createService: {} as never,
        getConfig: () => createDefaultControlConfig(),
        instanceRegistry: registry
    });

    await gateway.connectInstance("managed", "ctx-a");
    await gateway.connectInstance("managed", "ctx-a");
    await gateway.connectInstance("managed", "ctx-b");
    assert.equal(startCalls, 1);

    await gateway.releaseInstanceReference("managed", "ctx-a");
    assert.equal(stopCalls, 0);
    await gateway.releaseInstanceReference("managed", "ctx-b");
    assert.equal(stopCalls, 1);

    await gateway.connectInstance("external", "ctx-external");
    await gateway.releaseInstanceReference("external", "ctx-external");
    await registry.stopOwned();
    assert.equal(stopCalls, 1);
});
