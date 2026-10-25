import assert from "node:assert/strict";
import test from "node:test";
import { McpAppCall } from "../../src/mcpapp/Call.ts";
import { McpAppActionStore } from "../../src/mcpapp/ActionStore.ts";
import { McpNativeToolResult } from "../../src/protocol/Public.ts";

function fixture(ownsPresentation?: (toolName: string) => boolean, inlineToolCalls = false) {
    const actions = new McpAppActionStore();
    const called: string[] = [];
    const instance = "alpha";
    const ctxId = "ctx-one";
    const endpoint = new McpAppCall({ actions, instance,
        toolCallResourceUriForTool: (name) => inlineToolCalls &&
            ["artifact_viewImage", "bash_run", "file_edit", "file_read", "tmux_run"].includes(name)
            ? "ui://widget/toolcall.html?widgetRevision=1&toolName=" + name : undefined,
        ...(ownsPresentation === undefined ? {} : { ownsPresentation }),
        bootstrap: async () => ({ ctxId, token: "private-valid-capability-01", liveBaseUrl: "https://example.test/api/live" }),
        context: { resolve: async () => ({ status: "active", ctxId,
            environments: [{ instance, workspace: "/demo" }] }) } as never,
        dispatch: { callTool: async (name: string, input: Record<string, unknown>, _request: unknown,
            _signal?: AbortSignal, onExecuted?: (id: string, value: unknown, result: unknown) => void) => {
            called.push(name);
            if (name === "mcpapp_action") {
                const result = { status: "applied", itemId: input.itemId, actionId: input.actionId, input: input.input };
                onExecuted?.("audit-call", { context: { ctxId, instance, source: "mcp", workspace: "/demo" },
                    kind: "call", toolName: "mcpapp_action", payload: input }, result);
                return result;
            }
            throw new Error(`unexpected tool ${name}`);
        } } as never,
    });
    const request = { principal: "account", requestMeta: { "openai/session": "s1" } };
    return { actions, endpoint, called, request, instance, ctxId };
}

test("Live bootstrap failure does not discard the completed environ_info result", async (t) => {
    const warning = t.mock.method(console, "warn", () => undefined);
    const call = new McpAppCall({
        actions: new McpAppActionStore(),
        bootstrap: async () => { throw new Error("Live lease store unavailable"); },
        context: { resolve: async () => ({}) } as never,
        dispatch: { callTool: async () => ({ ok: true }) } as never,
        instance: "alpha",
    });
    const result = { ctxId: "ctx-one", instance: "alpha", ok: true };
    const presented = await call.present("environ_info", result, { principal: "account" } as never);
    assert.ok(presented instanceof McpNativeToolResult);
    assert.deepEqual(presented.structuredContent, result);
    assert.equal(presented._meta?.["portable-devshell/mcpapp"], undefined);
    assert.equal(warning.mock.callCount(), 1);
});

test("mcpapp_open returns private capability in protocol result", async () => {
    const f = fixture();
    const response = await f.endpoint.present("mcpapp_open", { status: "ready", ctxId: f.ctxId }, f.request);
    assert.ok(response instanceof McpNativeToolResult);
    assert.deepEqual(response.structuredContent, { status: "ready" });
    assert.equal(response._meta?.["portable-devshell/mcpapp"] &&
        (response._meta["portable-devshell/mcpapp"] as Record<string, unknown>).ctxId, f.ctxId);
});

test("MCP tool catalog keeps Fullscreen while restricting optional Inline to selected tools", async () => {
    const { McpEndpointCatalog } = await import("../../src/protocol/tool/Catalog.ts");
    const { McpExtensionRegistry } = await import("../../src/protocol/extension/Registry.ts");
    const { createMcpAppMcpExtension } = await import("../../src/mcpapp/Extension.ts");
    const { mcpAppOpenDefinition } =
        await import("../../../core/src/instance/mcpapp/Definition.ts");
    const extensions = new McpExtensionRegistry([createMcpAppMcpExtension("https://example.test", {
        inlineToolCalls: true,
    })]);
    const definitions = [
        mcpAppOpenDefinition(),
        { name: "environ_info", group: "environ", description: "Get environment",
            requiredCapabilities: [], inputSchema: { type: "object" }, outputSchema: { type: "object" } },
        { name: "file_read", group: "file", description: "Read file",
            requiredCapabilities: [], inputSchema: { type: "object" }, outputSchema: { type: "object" } },
        { name: "tmux_read", group: "tmux", description: "Read a task transcript",
            requiredCapabilities: [], inputSchema: { type: "object" }, outputSchema: { type: "object" } },
        { name: "progress_report", group: "progress", description: "Report progress",
            requiredCapabilities: [], inputSchema: { type: "object" }, outputSchema: { type: "object" } },
    ];
    const catalog = new McpEndpointCatalog({
        instanceName: "alpha",
        bootstrapPresentationResourceUri: extensions.environmentPresentation()?.resourceUri,
        toolCallPresentationResourceUri: extensions.environmentPresentation()?.toolCallResourceUri,
        toolCallPresentationResourceUriForTool:
            extensions.environmentPresentation()?.toolCallResourceUriForTool,
        source: {
            list: () => definitions.map((definition) => ({ scope: "*", definition })),
            get: (_instance, name) => {
                const definition = definitions.find((item) => item.name === name);
                return definition ? { scope: "*", definition } : undefined;
            },
        },
    });
    const [workspace, interaction, toolCall] = extensions.listResources();
    for (const resource of [workspace, interaction, toolCall])
        assert.equal(resource?.mimeType, "text/html;profile=mcp-app");
    const tools = catalog.listTools();
    assert.equal(tools.length, 5);
    for (const tool of tools) {
        if (["tmux_read", "progress_report", "environ_info"].includes(tool.name)) {
            const meta = tool._meta as Record<string, unknown> | undefined;
            assert.equal(meta?.["openai/outputTemplate"], undefined);
            continue;
        }
        const uri = tool.name === "mcpapp_open" ? workspace?.uri
            : toolCall?.uri + "?widgetRevision=1&toolName=" + tool.name;
        const meta = tool._meta as Record<string, unknown> | undefined;
        assert.equal(meta?.["openai/outputTemplate"], uri);
        assert.equal((meta?.ui as Record<string, unknown>)?.resourceUri, uri);
        if (tool.name !== "mcpapp_open")
            assert.equal(meta?.["openai/widgetAccessible"], undefined);
    }
    const workspaceContent = await extensions.readResource(workspace!.uri);
    const interactionContent = await extensions.readResource(interaction!.uri);
    const toolCallContent = await extensions.readResource(toolCall!.uri);
    assert.deepEqual(workspaceContent?._meta?.["openai/ui"], { availableDisplayModes: ["fullscreen"] });
    assert.deepEqual(interactionContent?._meta?.["openai/ui"], { availableDisplayModes: ["inline"] });
    assert.match(interactionContent?.text ?? "", /data-mcpapp-view="interaction"/u);
    assert.deepEqual(toolCallContent?._meta?.["openai/ui"], { availableDisplayModes: ["inline"] });
    assert.match(workspaceContent?.text ?? "", /data-mcpapp-view="workspace"/u);
    assert.match(toolCallContent?.text ?? "", /data-mcpapp-view="toolcall"/u);
    assert.equal(extensions.listResources().length, 3);
    for (const name of ["bash_run", "file_read", "file_edit", "progress_report"]) {
        const uri = toolCall?.uri + "?widgetRevision=1&toolName=" + name;
        const content = await extensions.readResource(uri);
        assert.equal(content?.uri, uri);
        assert.match(content?.text ?? "", new RegExp('data-tool-name="' + name + '"', "u"));
        assert.match(content?.text ?? "", /<script type="module"/u);
    }
    const oldWorkspace = "ui://portable-devshell/mcpapp-aaaaaaaaaaaaaaaa.html";
    const oldToolCall = "ui://portable-devshell/mcpapp-toolcall-cccccccccccccccc.html";
    for (const [uri, view] of [
        [oldWorkspace, "workspace"],
        [oldToolCall, "toolcall"],
    ]) {
        const content = await extensions.readResource(uri);
        assert.equal(content?.uri, uri);
        assert.match(content?.text ?? "", new RegExp('data-mcpapp-view="' + view + '"', "u"));
    }
    const oldToolVariant = oldToolCall + "?widgetRevision=1&toolName=file_read";
    assert.match((await extensions.readResource(oldToolVariant))?.text ?? "", /data-tool-name="file_read"/u);
    for (const bad of [
        toolCall?.uri + "?toolName=file_read",
        toolCall?.uri + "?widgetRevision=2&toolName=file_read",
        toolCall?.uri + "?widgetRevision=1&toolName=file_read&token=secret",
        toolCall?.uri + "?widgetRevision=1&toolName=%3Cscript%3E",
        oldToolCall + "?widgetRevision=1&toolName=file_read&token=secret",
        "ui://portable-devshell/mcpapp-toolcall-invalid.html?widgetRevision=1&toolName=file_read",
        oldWorkspace + "?untrusted=1",
    ]) assert.equal(await extensions.readResource(bad), undefined);
    assert.match(workspaceContent?.text ?? "", /<link rel="stylesheet"/u);
    assert.match(toolCallContent?.text ?? "", /<link rel="stylesheet"/u);
    for (const resource of [workspaceContent, toolCallContent])
        assert.equal(resource?.text?.includes("private-valid-capability-01"), false);
});

test("Inline is disabled by default while historical resources and Fullscreen remain available", async () => {
    const { createMcpAppMcpExtension } = await import("../../src/mcpapp/Extension.ts");
    const { McpEndpointCatalog } = await import("../../src/protocol/tool/Catalog.ts");
    const extension = createMcpAppMcpExtension("https://example.test");
    assert.equal(extension.presentation?.toolCallResourceUriForTool?.("bash_run"), undefined);
    assert.ok(extension.presentation?.resourceUri);
    assert.equal(extension.resources?.length, 3);
    const definitions = ["environ_info", "bash_run", "progress_report", "file_read"].map((name) => ({
        name, group: "test", description: "Test tool", requiredCapabilities: [],
        inputSchema: { type: "object" }, outputSchema: { type: "object" },
    }));
    const catalog = new McpEndpointCatalog({
        instanceName: "alpha",
        bootstrapPresentationResourceUri: extension.presentation?.resourceUri,
        toolCallPresentationResourceUriForTool: extension.presentation?.toolCallResourceUriForTool,
        source: {
            list: () => definitions.map((definition) => ({ scope: "*", definition })),
            get: (_instance, name) => {
                const definition = definitions.find((item) => item.name === name);
                return definition ? { scope: "*", definition } : undefined;
            },
        },
    });
    for (const tool of catalog.listTools()) {
        assert.equal((tool._meta as Record<string, unknown>)?.["openai/outputTemplate"], undefined);
        assert.equal((tool._meta as Record<string, unknown>)?.["ui/resourceUri"], undefined);
    }
    const f = fixture();
    for (const name of ["bash_run", "file_read", "progress_report", "environ_info"]) {
        const presented = await f.endpoint.present(name, { ok: true, ctxId: f.ctxId }, f.request);
        assert.ok(presented instanceof McpNativeToolResult);
        assert.equal(presented._meta?.["openai/outputTemplate"], undefined);
        assert.equal(presented._meta?.["portable-devshell/widgetPayload"], undefined);
    }
});

test("Inline opt-in still excludes frequent background and reporting tools", async () => {
    const f = fixture(undefined, true);
    for (const name of ["progress_report", "environ_info", "tmux_read", "tmux_input",
        "tmux_manage", "file_grep", "file_glob", "workspace_goal"]) {
        const presented = await f.endpoint.present(name, { ok: true }, f.request);
        assert.ok(presented instanceof McpNativeToolResult);
        assert.equal(presented._meta?.["portable-devshell/widgetPayload"], undefined);
        assert.equal(presented._meta?.["openai/outputTemplate"], undefined);
    }
});

test("MCP App tags ordinary ToolCall results for an inline card without altering execution", async () => {
    const f = fixture(undefined, true);
    const input = { command: "pwd", output: "ok" };
    const presented = await f.endpoint.present("bash_run", input, f.request);
    assert.ok(presented instanceof McpNativeToolResult);
    assert.deepEqual(presented.structuredContent, input);
    assert.deepEqual(presented._meta?.["portable-devshell/toolcall"], { name: "bash_run" });
    assert.equal(presented._meta?.["openai/outputTemplate"],
        "ui://widget/toolcall.html?widgetRevision=1&toolName=bash_run");
    assert.deepEqual(presented._meta?.["portable-devshell/widgetPayload"], {
        schema: "portable-devshell.toolcall.v1", toolName: "bash_run", isError: false, output: input,
    });
    assert.equal(presented._meta?.["portable-devshell/mcpapp"], undefined);
    assert.equal(JSON.stringify(presented.structuredContent).includes("private-valid-capability-01"), false);
});

test("tmux_read does not issue a Live capability for a background transcript poll", async () => {
    const f = fixture();
    const presented = await f.endpoint.present("tmux_read", { task: { id: "task-1" } }, f.request);
    assert.ok(presented instanceof McpNativeToolResult);
    assert.equal(presented._meta?.["portable-devshell/mcpapp"], undefined);
    assert.deepEqual(presented._meta?.["portable-devshell/toolcall"], { name: "tmux_read" });
    assert.equal(presented._meta?.["portable-devshell/widgetPayload"], undefined);
    assert.equal(presented._meta?.["openai/outputTemplate"], undefined);
});

test("A foreign MCP App resource cannot receive the DevShell Live bearer capability", async () => {
    const f = fixture(() => false);
    const presented = await f.endpoint.present("custom_widget", { ok: true }, f.request);
    assert.ok(presented instanceof McpNativeToolResult);
    assert.deepEqual(presented.structuredContent, { ok: true });
    assert.equal(presented._meta?.["portable-devshell/mcpapp"], undefined);
    assert.equal(presented._meta?.["portable-devshell/widgetPayload"], undefined);
    assert.equal(presented._meta?.["openai/outputTemplate"], undefined);
});

test("per-tool Widget metadata is self-contained and bounded without changing the original result", async () => {
    const f = fixture(undefined, true);
    const input = { command: "printf ready", purpose: "Check output", apiKey: "private-input-key" };
    const output = { stdout: "ready\n" + "x".repeat(80_000), exitCode: 0,
        nested: { token: "private-output-token" } };
    const presented = await f.endpoint.present("bash_run", output, f.request, input);
    assert.ok(presented instanceof McpNativeToolResult);
    assert.deepEqual(presented.structuredContent, output);
    const payload = presented._meta?.["portable-devshell/widgetPayload"] as Record<string, unknown>;
    assert.equal(payload.toolName, "bash_run");
    assert.equal((payload.input as Record<string, unknown>).command, "printf ready");
    assert.ok(JSON.stringify(payload).length < 37_000);
    assert.doesNotMatch(JSON.stringify(payload), /private-input-key|private-output-token/u);
    assert.match(JSON.stringify(payload), /\[redacted\]/u);
    assert.equal(presented._meta?.["openai/outputTemplate"],
        "ui://widget/toolcall.html?widgetRevision=1&toolName=bash_run");
});
