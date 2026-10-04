import assert from "node:assert/strict";
import test from "node:test";
import { ToolCallPipeline } from "@portable-devshell/core/testing";
import { ToolCallHookSequence } from "@portable-devshell/core/testing";

import {
    InstanceRegistry,
    McpInstanceGatewayControl,
    createDefaultControlConfig,
    createTestApprovalApi,
    createTestInstanceDomainRuntime,
    createTestTaskApi,
} from "../../../../src/testing.ts";
import { McpExtensionService } from "../../../../src/composition/mcp/extension/Service.ts";

function createGateway(
    ready: boolean,
    instanceDomains = createTestInstanceDomainRuntime(),
): McpInstanceGatewayControl {
    const registry = new InstanceRegistry([
        {
            enabled: true,
            mcpEnabled: true,
            mcpPath: "/remote-server/mcp",
            modelExtensions: ["instance"],
            name: "remote-server",
            worker: {
                snapshot() {
                    return { ready };
                },
            },
        } as never,
    ]);

    return new McpInstanceGatewayControl({
        getConfig: () => createDefaultControlConfig(),
        instanceDomains,
        instanceRegistry: registry,
    });
}

test("cross-instance readiness check reports core.instanceNotReady before schema lookup", () => {
    const gateway = createGateway(false);

    assert.throws(
        () => gateway.assertReady("remote-server"),
        (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                "core.instanceNotReady",
            );
            assert.deepEqual((error as { details?: unknown }).details, {
                instance: "remote-server",
            });
            return true;
        },
    );
});

test("cross-instance readiness check accepts a ready target", () => {
    const gateway = createGateway(true);

    assert.doesNotThrow(() => gateway.assertReady("remote-server"));
});

test("MCP approval adapter delegates through the instance domain approval port", async () => {
    const pending = {
        approvalId: "approval-1",
        ctxId: "ctx-1",
        status: "pending",
    };
    const decided = { ...pending, status: "approved" };
    const gateway = createGateway(
        true,
        createTestInstanceDomainRuntime({
            approval: (instance) =>
                instance === "alpha"
                    ? createTestApprovalApi({
                          async listApprovals() {
                              return [pending] as never;
                          },
                          async listPendingApprovals(ctxId?: string) {
                              return (
                                  ctxId === "ctx-1" ? [pending] : []
                              ) as never;
                          },
                          async decideApproval(
                              approvalId: string,
                              input: unknown,
                          ) {
                              assert.equal(approvalId, "approval-1");
                              assert.deepEqual(input, {
                                  decidedBy: "web",
                                  decision: "approve",
                              });
                              return decided as never;
                          },
                          async cancel() {
                              return pending as never;
                          },
                      })
                    : undefined,
        }),
    );

    assert.deepEqual(await gateway.approval.listApprovals("alpha"), [pending]);
    assert.deepEqual(
        await gateway.approval.listPendingApprovals?.("alpha", "ctx-1"),
        [pending],
    );
    assert.deepEqual(
        await gateway.approval.decideApproval?.(
            "alpha",
            "approval-1",
            "approve",
        ),
        decided,
    );
});

test("MCP gateway binds once and routes unknown original targets through host ingress", async () => {
    const gateway = createGateway(true);
    const dispatched: unknown[] = [];
    const pipeline = new ToolCallPipeline({
        hooks: () => ({
            release() {},
            sequence: new ToolCallHookSequence({
                rewrites: [
                    ({ value, direction }) =>
                        direction === "inbound"
                            ? {
                                  ...value,
                                  context: {
                                      ...value.context,
                                      instance: "remote-server" as never,
                                  },
                                  toolName: "final_tool",
                                  payload: { rewritten: true },
                              }
                            : value,
                ],
            }),
        }),
        resolveTarget(instance) {
            assert.equal(instance, "remote-server");
            return {
                async dispatch(request) {
                    dispatched.push(request.value);
                    const input =
                        (await request.invocationInput?.(
                            request.value.payload,
                            request.callId,
                            request.value,
                        )) ?? request.value.payload;
                    const result =
                        request.operation === undefined
                            ? input
                            : await request.operation(
                                  request.callId,
                                  input,
                                  request.value,
                              );
                    request.onProgress?.({ progress: true });
                    return (
                        (await request.transformResult?.(
                            result,
                            request.callId,
                        )) ?? result
                    );
                },
            };
        },
    });
    gateway.bindToolCalls(pipeline);
    assert.throws(() => gateway.bindToolCalls(pipeline), /already bound/);
    const progress: unknown[] = [];
    const signal = new AbortController().signal;
    assert.deepEqual(
        await gateway.callTool(
            "unknown",
            "original",
            {},
            { source: "mcp" },
            signal,
            async (result) => ({ result }),
            (input, callId, value) => {
                assert.equal(typeof callId, "string");
                assert.equal(value.context.instance, "remote-server");
                return input;
            },
            (value) => progress.push(value),
            "caller",
        ),
        { result: { rewritten: true } },
    );
    assert.deepEqual(progress, [{ progress: true }]);
    assert.deepEqual(
        await gateway.callToolOperation(
            "unknown",
            "original",
            {},
            { source: "mcp" },
            async (_callId, input, value) => ({
                input,
                instance: value.context.instance,
                toolName: value.toolName,
            }),
        ),
        {
            input: { rewritten: true },
            instance: "remote-server",
            toolName: "final_tool",
        },
    );
    assert.equal(dispatched.length, 2);
});

test("closing an MCP tool session releases worker-owned session state", async () => {
    const released: string[] = [];
    const registry = new InstanceRegistry(
        ["local-one", "remote-two"].map((name) => ({
            enabled: true,
            mcpEnabled: true,
            mcpPath: `/${name}/mcp`,
            modelExtensions: [],
            name,
            worker: {
                async releaseToolSession(sessionId: string) {
                    released.push(`${name}:${sessionId}`);
                },
            },
        })) as never,
    );
    const gateway = new McpInstanceGatewayControl({
        getConfig: () => createDefaultControlConfig(),
        instanceDomains: createTestInstanceDomainRuntime(),
        instanceRegistry: registry,
    });

    await gateway.closeToolSession("session-shared");

    assert.deepEqual(released.sort(), [
        "local-one:session-shared",
        "remote-two:session-shared",
    ]);
});

test("MCP instance lifecycle responses preserve active Todo summaries", async () => {
    const activeTodos = [
        {
            completed: 1,
            currentItem: "Verify release lifecycle",
            revision: 3,
            status: "in_progress" as const,
            taskId: "release-review",
            title: "Release review",
            total: 2,
        },
    ];
    const snapshot = {
        connectionState: "disconnected",
        daemonState: "stopped",
        lastSeq: 4,
        name: "remote-server",
        ready: false,
        status: "stopped",
    };
    let currentSnapshot = snapshot;
    let startCalls = 0;
    const registry = new InstanceRegistry([
        {
            enabled: true,
            mcpEnabled: true,
            mcpPath: "/remote-server/mcp",
            modelExtensions: ["instance"],
            name: "remote-server",
            worker: {
                managementMode: "controllerManaged",
                snapshot() {
                    return currentSnapshot;
                },
                async start() {
                    startCalls += 1;
                    currentSnapshot = {
                        ...snapshot,
                        daemonState: "running",
                        ready: true,
                        status: "ready",
                    };
                    return currentSnapshot;
                },
                async stop() {
                    currentSnapshot = snapshot;
                    return currentSnapshot;
                },
            },
        } as never,
    ]);
    const gateway = new McpInstanceGatewayControl({
        getConfig: () => createDefaultControlConfig(),
        instanceDomains: createTestInstanceDomainRuntime({
            task: (instance) =>
                instance === "remote-server"
                    ? createTestTaskApi({
                          todo: {
                              ...createTestTaskApi().todo,
                              summaries: () => activeTodos,
                          },
                      })
                    : undefined,
        }),
        instanceRegistry: registry,
    });

    assert.deepEqual(
        (
            (await gateway.connectInstance("remote-server", "ctx-one")) as {
                activeTodos?: unknown;
            }
        ).activeTodos,
        activeTodos,
    );
    await gateway.connectInstance("remote-server", "ctx-one");
    assert.equal(startCalls, 1);
    assert.deepEqual(
        (
            (await gateway.stopInstance("remote-server")) as {
                activeTodos?: unknown;
            }
        ).activeTodos,
        activeTodos,
    );
});

test("MCP instance connect lifecycle uses Context references without adopting an already-ready worker", async () => {
    let ready = false;
    let startCalls = 0;
    let stopCalls = 0;
    const registry = new InstanceRegistry([
        {
            enabled: true,
            mcpEnabled: true,
            mcpPath: "/managed/mcp",
            modelExtensions: ["instance"],
            name: "managed",
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
                },
            },
        } as never,
        {
            enabled: true,
            mcpEnabled: true,
            mcpPath: "/external/mcp",
            modelExtensions: ["instance"],
            name: "external",
            worker: {
                managementMode: "controllerManaged",
                snapshot: () => ({ ready: true }),
                async stop() {
                    stopCalls += 100;
                    return { ready: false };
                },
            },
        } as never,
    ]);
    const gateway = new McpInstanceGatewayControl({
        getConfig: () => createDefaultControlConfig(),
        instanceDomains: createTestInstanceDomainRuntime(),
        instanceRegistry: registry,
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

test("MCP Extension tools hold their generation lease through invocation", async () => {
    let releases = 0;
    const service = new McpExtensionService({
        listDeclarations(pointId: string) {
            assert.equal(pointId, "mcp.tools");
            return [
                {
                    declaration: {
                        activity: "observation",
                        description: "Send progress.",
                        destructiveHint: false,
                        id: "todo_report",
                        idempotentHint: false,
                        inputSchema: {
                            properties: {
                                message: {
                                    description: "Progress message.",
                                    type: "string",
                                },
                            },
                            type: "object",
                        },
                        openWorldHint: false,
                        outputSchema: {
                            properties: { reported: { type: "boolean" } },
                            type: "object",
                        },
                        readOnlyHint: false,
                        title: "Message user",
                    },
                    extensionId: "comment",
                    id: "todo_report",
                },
            ] as never;
        },
        async acquireRegistration(pointId: string, id: string) {
            assert.equal(pointId, "mcp.tools");
            assert.equal(id, "todo_report");
            return {
                extensionId: "comment",
                lease: {
                    release() {
                        releases += 1;
                    },
                },
                registration: {
                    binding: async (
                        input: unknown,
                        context: { ctxId?: string },
                    ) => {
                        assert.deepEqual(input, { message: "done" });
                        assert.equal(context.ctxId, "ctx-one");
                        return {
                            content: [{ text: "done", type: "text" }],
                            structuredContent: { reported: true },
                        };
                    },
                },
            } as never;
        },
    } as never);

    const [tool] = service.listTools();
    assert.equal(tool?.name, "todo_report");
    assert.equal(tool?.description, "Send progress.");
    assert.deepEqual(tool?._meta, {
        devshell: {
            extensionId: "comment",
            mcp: {
                activity: "observation",
                annotations: {
                    destructiveHint: false,
                    idempotentHint: false,
                    openWorldHint: false,
                    readOnlyHint: false,
                },
                extensionTool: true,
                preserveInputDescriptions: true,
                title: "Message user",
            },
        },
    });
    assert.deepEqual(
        await service.callTool(
            "todo_report",
            { message: "done" },
            {
                callId: "call-one",
                ctxId: "ctx-one",
                instance: "remote-server",
            },
        ),
        {
            content: [{ text: "done", type: "text" }],
            structuredContent: { reported: true },
        },
    );
    assert.equal(releases, 1);
});

test("MCP Context terminal delegates to Extension Context environment retirement", async () => {
    const calls: Array<{
        ctxId: string;
        instance: string;
        reason: "disabled" | "expired";
    }> = [];
    const service = new McpExtensionService({
        listDeclarations() {
            return [];
        },
        async acquireRegistration() {
            throw new Error("unexpected registration lookup");
        },
        async contextEnvironmentRetired(input: {
            ctxId: string;
            instance: string;
            reason: "disabled" | "expired";
        }) {
            calls.push(input);
        },
    } as never);

    await service.contextTerminated("remote-server", "ctx-one", "expired");
    assert.deepEqual(calls, [
        {
            ctxId: "ctx-one",
            instance: "remote-server",
            reason: "expired",
        },
    ]);
});
