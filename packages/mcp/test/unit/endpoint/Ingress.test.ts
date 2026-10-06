import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    type ContextRecord,
    type ContextTransport,
    type JsonValue,
    type ToolCallHookValue,
    type ToolCallPresentation,
    type ToolDefinition,
} from "@portable-devshell/shared";
import { McpEndpointWorker } from "../../../src/endpoint/Endpoint.ts";
import type { ToolCallIngressPort } from "../../../src/endpoint/call/Port.ts";
import { McpNativeToolResult } from "../../../src/endpoint/call/Boundary.ts";
import { readMcpRoutedInput } from "../../../src/endpoint/tool/Input.ts";
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
    const endpoint = new McpEndpointWorker({
        context: { async resolve() { throw new Error("bootstrap must not resolve a Context"); } } as never,
        instanceName: "alpha",
        toolSource,
        tools,
        worker: workerPort(),
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
    const workerEvents: unknown[] = [];
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
    const endpoint = new McpEndpointWorker({
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
        worker: {
            ...workerPort(),
            async appendMcpToolCalled(toolName, context) {
                workerEvents.push({ context, toolName });
            },
        },
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
    assert.deepEqual(workerEvents, [{
        context: {
            ctxId: "ctx-alpha",
            instance: "alpha",
            requestId: "request-1",
            source: "mcp",
            workspace: "/work/alpha",
        },
        toolName: "bash_run",
    }]);
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

const bootstrapTool: ToolDefinition = {
    description: "Create or find a workspace Context.",
    group: "environ",
    inputSchema: { type: "object" },
    name: "environ_info",
    outputSchema: { type: "object" },
    requiredCapabilities: [],
};

function workerPort() {
    return {
        snapshot: () => ({ ready: true }),
        async appendMcpSessionClosed() {},
        async appendMcpSessionOpened() {},
        async appendMcpToolCalled() {},
        async readAlerts() { return { advice: [] }; },
    };
}
