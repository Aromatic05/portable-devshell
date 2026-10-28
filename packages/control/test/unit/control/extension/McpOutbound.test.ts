import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { presentToolCallResult, runtimeErrorCodes, type JsonValue, type ToolCallHookValue, type ToolDefinition } from "@portable-devshell/shared";
import { McpExtensionService } from "../../../../src/extension/api/point/mcp/index.ts";
import { createToolCallRegistry } from "../../../../src/toolcall/index.ts";
import { round4Target } from "../../../../../core/test/unit/tool/Round4Harness.ts";
import { McpProtocolRoute } from "../../../../../mcp/src/protocol/Route.ts";
import { Round4MemoryHttp } from "../../../../../mcp/test/integration/AuthTransportRound4MemoryHttp.ts";
import { modernRequestInit, modernRpcRequest } from "../../../../../mcp/test/integration/ModernProtocol.ts";
import { parseMcpHttpResponse } from "../../../../../mcp/test/TestMcpHttpResponse.ts";

const protocolMeta = {
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "portable-devshell-mcp", version: "0.0.0" } },
    resultType: "complete",
};

const original = {
    content: [{ type: "text", text: "SENTINEL native" }],
    structuredContent: { message: "SENTINEL structured" },
};

async function fixture(t: TestContext, rewrite?: (value: ToolCallHookValue) => ToolCallHookValue,
    toolResult: { content?: { type: string; text: string }[]; structuredContent: { message: string } } = original) {
    const h = await round4Target();
    t.after(() => h.close());
    let effects = 0;
    const registry = createToolCallRegistry();
    let definitions: readonly ToolDefinition[] = [];
    const unbind = registry.bind({
        changes: { onChange: () => () => {} },
        instances: {
            onAdding: () => () => {},
            list: () => [{
                config: { name: "round4", mcpEnabled: true },
                toolCallHooks: h.runtime.hooks,
                toolDefinitions: {
                    list: () => definitions,
                    register(initial) {
                        definitions = initial;
                        return { replace(next) { definitions = next; }, dispose() { definitions = []; } };
                    },
                },
            }],
        },
    });
    const service = new McpExtensionService({
        listDeclarations: () => [{ extensionId: "sentinel", id: "sentinel_read", declaration: {
            id: "sentinel_read", title: "Read sentinel", description: "Read a sentinel.",
            inputSchema: { type: "object" }, outputSchema: { type: "object" },
        } }] as never,
        onChange: () => () => {},
        async acquireRegistration() {
            return { extensionId: "sentinel", lease: { release() {} }, registration: {
                binding: async () => { effects++; return toolResult; },
            } } as never;
        },
    });
    const uninstall = service.install(registry);
    t.after(() => { uninstall(); unbind(); });
    const reviews: JsonValue[] = [];
    const order: string[] = [];
    h.runtime.hooks.registerContributor(() => ({
        release() {},
        rewrites: rewrite === undefined ? [] : [{ hook: "sentinel", id: "replace", rewrite(input) {
            if (input.direction !== "outbound") return input.value;
            order.push("rewrite");
            return rewrite(input.value);
        } }],
    }));
    h.runtime.hooks.registerReview({ hook: "sentinel", id: "observe", review(input) {
        if (input.direction === "outbound") {
            order.push("review");
            reviews.push(input.value.payload);
        }
        return { decision: input.direction === "outbound" ? "reject" : "continue" };
    } });
    const http = new Round4MemoryHttp();
    const protocol = new McpProtocolRoute(http);
    protocol.registerInstance({
        instanceName: "round4", toolSource: registry, tools: h.runtime.api,
        context: { async resolve() { return {
            ctxId: "sentinel-context", principal: "local", status: "active",
            createdAt: "2026-10-28T00:00:00Z", lastAccessedAt: "2026-10-28T00:00:00Z",
            expiresAt: "2099-10-28T00:00:00Z",
            environments: [{ instance: "round4", workspace: h.directory }],
        }; } },
    }, "/round4/mcp");
    protocol.start();
    t.after(async () => { protocol.stop(); await protocol.drain(); });
    const call = async (name = "sentinel_read") => {
        const response = await http.fetch(`${http.origin}/round4/mcp`, modernRequestInit("tools/call",
            modernRpcRequest("sentinel-call", "tools/call", { name, arguments: { ctxId: "sentinel-context" } })));
        assert.equal(response.status, 200);
        return parseMcpHttpResponse<{ result?: JsonValue; error?: { data: Record<string, JsonValue> } }>(await response.text());
    };
    return { ...h, registry, call, reviews, order, effects: () => effects };
}

test("legal MCP Extension native and structured output pass through one outbound Rewrite at the Host", async (t) => {
    const h = await fixture(t, (value) => ({ ...value,
        payload: JSON.parse(JSON.stringify(value.payload).replaceAll("SENTINEL", "REWRITTEN")) as JsonValue,
    }));
    const output = await h.call();
    assert.equal(output.error, undefined);
    assert.deepEqual(output.result, {
        ...protocolMeta,
        content: [{ type: "text", text: "REWRITTEN native" }],
        structuredContent: { message: "REWRITTEN structured" }, isError: false,
    });
    assert.deepEqual(h.order, ["rewrite", "review"]);
    assert.equal(h.effects(), 1);
    const [record] = await h.history.read();
    assert.deepEqual(record?.output, h.reviews[0]);
    assert.deepEqual(record?.output, {
        content: [{ type: "text", text: "REWRITTEN native" }],
        structuredContent: { message: "REWRITTEN structured" },
    });
    assert.deepEqual(original.content, [{ type: "text", text: "SENTINEL native" }]);
});

test("MCP Extension without Rewrite preserves native and structured Host output", async (t) => {
    const h = await fixture(t);
    assert.deepEqual((await h.call()).result, { ...protocolMeta, ...original, isError: false });
    assert.equal(h.effects(), 1);
    assert.deepEqual(h.order, ["review"]);
    const [record] = await h.history.read();
    assert.deepEqual(record?.output, original);
});

test("MCP outbound Rewrite failure after execution reports non-retryable delivery failure without replay", async (t) => {
    const h = await fixture(t, () => { throw new Error("rewrite failed SENTINEL"); });
    const output = await h.call();
    assert.equal(output.result, undefined);
    assert.equal(output.error?.data.code, runtimeErrorCodes.toolResultDeliveryFailed);
    assert.equal(output.error?.data.retryable, false);
    assert.equal(JSON.stringify(output).includes("SENTINEL"), false);
    assert.equal(h.effects(), 1);
    const [record] = await h.history.read();
    assert.equal(record?.executionCompleted, true);
    assert.equal(record?.failureStage, "outboundHook");
    assert.equal(record?.output, undefined);
    assert.deepEqual(output.error?.data.details, {
        callId: record?.callId, executionCompleted: true, failureStage: "outboundHook",
    });
    assert.deepEqual(h.order, ["rewrite"]);
});


test("MCP Rewrite must retain its native envelope; malformed delivery never replays execution", async (t) => {
    const h = await fixture(t, (value) => ({ ...value, payload: { message: "only structured" } }));
    const output = await h.call();
    assert.equal(output.result, undefined);
    assert.equal(output.error?.data.code, runtimeErrorCodes.toolResultDeliveryFailed);
    assert.equal(output.error?.data.retryable, false);
    assert.equal(h.effects(), 1);
    const [record] = await h.history.read();
    assert.equal(record?.executionCompleted, true);
    assert.equal(record?.failureStage, "outboundHook");
    assert.equal(record?.output, undefined);
});

test("MCP tools without presentation retain the result payload Rewrite contract", async (t) => {
    const h = await fixture(t, (value) => {
        assert.deepEqual(value.payload, original.structuredContent);
        return { ...value, payload: { message: "REWRITTEN" } };
    }, { structuredContent: original.structuredContent });
    const output = await h.call();
    assert.deepEqual(output.result, { ...protocolMeta, content: [], isError: false,
        structuredContent: { message: "REWRITTEN" } });
    const [record] = await h.history.read();
    assert.deepEqual(record?.output, { message: "REWRITTEN" });
});

test("MCP native imagery survives the same outbound payload Rewrite and Host decoding", async (t) => {
    const h = await fixture(t, (value) => ({ ...value,
        payload: JSON.parse(JSON.stringify(value.payload).replaceAll("SENTINEL", "REWRITTEN")) as JsonValue,
    }));
    const registration = h.registry.register("round4", [{
        name: "image_read", group: "image", description: "Read image", requiredCapabilities: [],
        inputSchema: { type: "object" }, outputSchema: { type: "object" },
    }]);
    t.after(() => registration.dispose());
    h.runtime.hooks.registerExecute("image_read", async () => presentToolCallResult(
        { message: "SENTINEL image" }, { content: [
            { type: "text", text: "SENTINEL caption" },
            { type: "image", data: "aW1hZ2U=", mediaType: "image/png" },
        ], isError: false }));
    const output = await h.call("image_read");
    assert.deepEqual(output.result, { ...protocolMeta, isError: false,
        content: [{ type: "text", text: "REWRITTEN caption" },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
        structuredContent: { message: "REWRITTEN image" },
    });
    const [record] = await h.history.read();
    assert.deepEqual(record?.output, h.reviews[0]);
});
