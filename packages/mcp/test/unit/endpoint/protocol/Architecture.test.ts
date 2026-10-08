import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    type ContextRecord,
    type ContextTransport,
    type JsonValue,
    type ToolCallApi,
    type ToolCallHookValue,
    type ToolCallPresentation,
    type ToolDefinition,
} from "@portable-devshell/shared";
import { McpEndpointCatalog } from "../../../../src/endpoint/tool/Catalog.ts";
import { McpEndpointDispatch } from "../../../../src/endpoint/dispatch/Dispatch.ts";
import { McpNativeToolResult } from "../../../../src/endpoint/call/Boundary.ts";
import { TestToolSource } from "../../../support/ToolSource.ts";

const contextRecord: ContextRecord = {
    createdAt: "2026-10-05T00:00:00.000Z",
    ctxId: "ctx-alpha",
    environments: [{ instance: "alpha", workspace: "/work/alpha" }],
    expiresAt: "2026-10-06T00:00:00.000Z",
    lastAccessedAt: "2026-10-05T00:00:00.000Z",
    principal: "user-alpha",
    status: "active",
};

const bootstrapTool: ToolDefinition = {
    description: "Create or find a workspace Context.",
    group: "environ",
    inputSchema: { type: "object" },
    name: "environ_info",
    outputSchema: { type: "object" },
    requiredCapabilities: [],
};

const workerTool: ToolDefinition = {
    description: "Run a command.",
    group: "bash",
    inputSchema: {
        additionalProperties: false,
        properties: { command: { type: "string" } },
        required: ["command"],
        type: "object",
    },
    name: "bash_run",
    outputSchema: { type: "object" },
    requiredCapabilities: ["execute"],
};

test("catalog scopes current tool definitions and injects routing only when enabled", () => {
    const source = new TestToolSource();
    source.register("*", [bootstrapTool]);
    source.register("alpha", [workerTool]);

    const catalog = new McpEndpointCatalog({
        instanceName: "alpha",
        instanceRoutingEnabled: true,
        source,
    });

    assert.deepEqual(
        catalog.snapshot().entries.map(({ definition, scope }) => [
            definition.name,
            scope,
        ]),
        [
            ["environ_info", "*"],
            ["bash_run", "alpha"],
        ],
    );
    const bash = catalog.listTools().find((tool) => tool.name === "bash_run");
    const properties = (bash?.inputSchema as {
        properties?: Record<string, unknown>;
    }).properties;
    assert.ok(properties?.instance);
    assert.equal(catalog.getTool("bash_run")?.name, "bash_run");
});

test("bootstrap calls use the shared ToolCall API without resolving Context", async () => {
    const source = new TestToolSource();
    source.register("*", [bootstrapTool]);
    const calls: unknown[][] = [];
    const tools: ToolCallApi = {
        async call(...args) {
            calls.push(args);
            return { ctxId: "ctx-created", workspace: "/work/alpha" };
        },
    };
    const context: Pick<ContextTransport, "resolve"> = {
        async resolve() {
            throw new Error("bootstrap must not resolve a Context");
        },
    };
    const dispatch = new McpEndpointDispatch({
        catalog: new McpEndpointCatalog({
            instanceName: "alpha",
            source,
        }),
        context,
        instanceName: "alpha",
        tools,
    });

    assert.deepEqual(
        await dispatch.callTool(
            "environ_info",
            { workspace: "/work/alpha" },
            { principal: "user-alpha", requestId: "request-bootstrap" },
        ),
        { ctxId: "ctx-created", workspace: "/work/alpha" },
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.slice(0, 4), [
        "alpha",
        "environ_info",
        { workspace: "/work/alpha" },
        {
            contextMode: "explicit",
            externalBindings: [],
            principal: "user-alpha",
            requestId: "request-bootstrap",
            source: "mcp",
        },
    ]);
});

test("worker calls resolve Context and preserve the shared presentation", async () => {
    const source = new TestToolSource();
    source.register("alpha", [workerTool]);
    const resolutions: unknown[] = [];
    const context: Pick<ContextTransport, "resolve"> = {
        async resolve(request) {
            resolutions.push(request);
            return contextRecord;
        },
    };
    const presentation: ToolCallPresentation = {
        content: [{ type: "text", text: "command completed" }],
    };
    let accepted: {
        input: JsonValue;
        value: ToolCallHookValue;
    } | undefined;
    const tools: ToolCallApi = {
        async call(
            instance,
            toolName,
            input,
            callContext,
            _signal,
            transformResult,
            invocationInput,
        ) {
            const value: ToolCallHookValue = {
                context: { ...callContext, instance: asInstanceName(instance) },
                kind: "call",
                payload: input,
                toolName,
            };
            accepted = {
                input:
                    (await invocationInput?.(input, "call-1", value)) ?? input,
                value,
            };
            return await transformResult!(
                { exitCode: 0, stdout: accepted.input },
                "call-1",
                presentation,
            );
        },
    };
    const dispatch = new McpEndpointDispatch({
        catalog: new McpEndpointCatalog({ instanceName: "alpha", source }),
        context,
        instanceName: "alpha",
        tools,
    });

    const result = await dispatch.callTool(
        "bash_run",
        {
            command: "pwd",
            ctxId: "ctx-alpha",
            explanation: "Check the active workspace.",
            purpose: "Confirm the working directory.",
        },
        { principal: "user-alpha", requestId: "request-1" },
    );

    assert.deepEqual(resolutions, [
        {
            acceptExpired: false,
            ctxId: "ctx-alpha",
            principal: "user-alpha",
            touch: false,
        },
        {
            ctxId: "ctx-alpha",
            instance: "alpha",
            principal: "user-alpha",
            renewExpired: true,
            touch: true,
        },
    ]);
    assert.deepEqual(accepted?.input, { command: "pwd" });
    assert.equal(accepted?.value.context.instance, "alpha");
    assert.ok(result instanceof McpNativeToolResult);
    assert.deepEqual(result.content, presentation.content);
    assert.deepEqual(result.structuredContent, {
        exitCode: 0,
        stdout: { command: "pwd" },
    });
});
