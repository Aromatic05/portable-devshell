import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    type ContextRecord,
    type ContextTransport,
    type JsonValue,
    type ToolCallHookValue,
    type ToolCallPresentation,
    type ToolCallIngressPort,
    type ToolDefinition,
} from "@portable-devshell/shared";
import { McpEndpoint } from "../../../src/protocol/Endpoint.ts";
import { McpNativeToolResult } from "../../../src/protocol/call/Boundary.ts";
import { readMcpRoutedInput } from "../../../src/protocol/tool/Input.ts";
import { TestToolSource } from "../../support/ToolSource.ts";

const contextRecord: ContextRecord = {
    createdAt: "2026-10-05T00:00:00.000Z",
    ctxId: "ctx-alpha",
    environments: [{ instance: "alpha", workspace: "/work/alpha" }],
    expiresAt: "2026-10-06T00:00:00.000Z",
    lastAccessedAt: "2026-10-05T00:00:00.000Z",
    principal: "user-alpha",
    status: "active",
};

const workerTool: ToolDefinition = {
    description: "Run a command.",
    group: "bash",
    inputSchema: { additionalProperties: false, properties: { command: { type: "string" } }, type: "object" },
    name: "bash_run",
    outputSchema: { type: "object" },
    requiredCapabilities: ["execute"],
};

test("bootstrap tools enter the shared Control ingress with the current instance", async () => {
    const calls: unknown[][] = [];
    const tools: ToolCallIngressPort = {
        async call(...args) {
            calls.push(args);
            return { bootstrapped: true };
        },
    };
    const toolSource = new TestToolSource();
    toolSource.register("*", [bootstrapTool]);
    const endpoint = new McpEndpoint({
        context: { async resolve() { throw new Error("bootstrap must not resolve a Context"); } } as never,
        instanceName: "alpha",
        toolSource,
        tools,
    });

    assert.deepEqual(
        await endpoint.callTool("environ_info", { workspace: "/work/alpha" }, {
            principal: "user-alpha",
            requestId: "request-bootstrap",
        }),
        { bootstrapped: true },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "alpha");
    assert.equal(calls[0]?.[1], "environ_info");
    assert.deepEqual(calls[0]?.[2], { workspace: "/work/alpha" });
    assert.deepEqual(calls[0]?.[3], {
        contextMode: "explicit",
        externalBindings: [],
        principal: "user-alpha",
        requestId: "request-bootstrap",
        source: "mcp",
    });
});

test("workspace calls pass through Control callbacks and preserve worker presentation", async () => {
    const registry = new TestToolSource();
    registry.register("alpha", [workerTool]);
    const contextLookups: unknown[] = [];
    const provenance: unknown[] = [];
    const ingress: unknown[] = [];
    const presentation: ToolCallPresentation = {
        content: [{ type: "text", text: "command completed" }],
    };
    const tools: ToolCallIngressPort = {
        async call(...args) {
            ingress.push(args);
            const [instance, toolName, input, context, _signal, transformResult, invocationInput] = args;
            assert.equal(instance, "alpha");
            assert.equal(toolName, "bash_run");
            assert.deepEqual(context, {
                ctxId: "ctx-alpha",
                requestId: "request-1",
                source: "mcp",
                workspace: "/work/alpha",
            });
            const hookValue: ToolCallHookValue = {
                context: { ...context, instance: asInstanceName("alpha") },
                kind: "call",
                payload: input,
                toolName,
            };
            const acceptedInput = await invocationInput!(input, "call-1", hookValue);
            const result = { exitCode: 0, stdout: acceptedInput } as JsonValue;
            await transformResult!(result, "call-1", presentation);
            return result;
        },
    };
    const endpoint = new McpEndpoint({
        context: {
            async resolve(request: Parameters<ContextTransport["resolve"]>[0]) {
                contextLookups.push(request);
                return contextRecord;
            },
        } as never,
        instanceName: "alpha",
        toolProvenance: { async record(record) { provenance.push(record); } },
        toolSource: registry,
        tools,
    });

    const result = await endpoint.callTool("bash_run", {
        command: "pwd",
        ctxId: "ctx-alpha",
        explanation: "Check the active workspace.",
        purpose: "Confirm the working directory.",
    }, { principal: "user-alpha", requestId: "request-1" });

    assert.equal(ingress.length, 1);
    const ingressCall = ingress[0] as unknown[];
    assert.deepEqual(ingressCall[2], { command: "pwd" });
    assert.equal(contextLookups.length, 2);
    assert.deepEqual(provenance, [{
        callId: "call-1",
        explanation: "Check the active workspace.",
        instance: "alpha",
        purpose: "Confirm the working directory.",
    }]);
    assert.ok(result instanceof McpNativeToolResult);
    assert.deepEqual(result.content, [{ type: "text", text: "command completed" }]);
    assert.deepEqual(result.structuredContent, { exitCode: 0, stdout: { command: "pwd" } });
});

test("a Context owned by another principal is rejected before tool ingress", async () => {
    const registry = new TestToolSource();
    registry.register("alpha", [workerTool]);
    let ingressCalls = 0;
    const endpoint = new McpEndpoint({
        context: {
            async resolve(request: Parameters<ContextTransport["resolve"]>[0]) {
                assert.equal(request.ctxId, "ctx-alpha");
                assert.equal(request.principal, "user-intruder");
                throw new Error("Context principal mismatch");
            },
        } as never,
        instanceName: "alpha",
        toolSource: registry,
        tools: {
            async call() {
                ingressCalls++;
                return { exitCode: 0 };
            },
        },
    });

    await assert.rejects(
        endpoint.callTool(
            "bash_run",
            { command: "pwd", ctxId: "ctx-alpha" },
            { principal: "user-intruder", requestId: "foreign-context" },
        ),
        /Context principal mismatch/u,
    );
    assert.equal(ingressCalls, 0);
});

test("routed input validates the opt-in and strips the target before tool execution", () => {
    assert.deepEqual(
        readMcpRoutedInput({ command: "pwd", instance: "beta" }, true, "alpha"),
        { input: { command: "pwd" }, instance: "beta" },
    );
    assert.throws(
        () => readMcpRoutedInput({ command: "pwd", instance: "beta" }, false, "alpha"),
        /only available when instance management is exposed/u,
    );
});

test("a single MCP endpoint routes a call to an attached remote without leaking instance to the Worker", async () => {
    const registry = new TestToolSource();
    registry.register("alpha", [workerTool]);
    const attached: ContextRecord = {
        ...contextRecord,
        environments: [
            ...contextRecord.environments,
            { instance: "beta", workspace: "/work/beta" },
        ],
    };
    const dispatched: string[] = [];
    const tools: ToolCallIngressPort = {
        async call(instance, toolName, input, context, _signal, _transform, invocationInput) {
            dispatched.push(instance);
            assert.equal(toolName, "bash_run");
            assert.deepEqual(input, { command: "pwd" });
            assert.equal(context.workspace, "/work/beta");
            const value: ToolCallHookValue = {
                context: { ...context, instance: asInstanceName(instance) },
                kind: "call",
                payload: input,
                toolName,
            };
            await invocationInput!(input, "remote-call-1", value);
            return { exitCode: 0, stdout: "/work/beta" };
        },
    };
    const endpoint = new McpEndpoint({
        context: {
            async resolve(request: Parameters<ContextTransport["resolve"]>[0]) {
                if (request.instance !== undefined &&
                    !attached.environments.some((environment) => environment.instance === request.instance)) {
                    throw new Error("instance is not attached to this Context");
                }
                return attached;
            },
        } as never,
        instanceName: "alpha",
        instanceRoutingEnabled: true,
        toolSource: registry,
        tools,
    });
    const schema = endpoint.listTools().find((tool) => tool.name === "bash_run")?.inputSchema;
    assert.match(JSON.stringify(schema), /"instance":\s*\{/u);
    const request = { principal: "user-alpha", requestId: "request-remote" };
    const result = await endpoint.callTool("bash_run", {
        command: "pwd",
        ctxId: "ctx-alpha",
        instance: "beta",
    }, request);
    assert.deepEqual(result, { exitCode: 0, stdout: "/work/beta" });
    assert.deepEqual(dispatched, ["beta"]);
    await assert.rejects(
        endpoint.callTool("bash_run", {
            command: "pwd",
            ctxId: "ctx-alpha",
            instance: "not-attached",
        }, request),
        /not attached/u,
    );
    assert.deepEqual(dispatched, ["beta"]);
});

const bootstrapTool: ToolDefinition = {
    description: "Create or find a workspace Context.",
    group: "environ",
    inputSchema: { type: "object" },
    name: "environ_info",
    outputSchema: { type: "object" },
    requiredCapabilities: [],
};
