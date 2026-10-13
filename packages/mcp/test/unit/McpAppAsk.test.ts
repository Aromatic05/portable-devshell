import assert from "node:assert/strict";
import test from "node:test";
import { McpAppCall } from "../../src/mcpapp/Call.ts";
import { McpAppQuestionStore } from "../../src/mcpapp/Question.ts";
import { McpAppActionStore } from "../../src/mcpapp/ActionStore.ts";
import { McpAppPresenceStore } from "../../src/mcpapp/app/Presence.ts";
import { McpNativeToolResult } from "../../src/protocol/Public.ts";

function fixture(ownsPresentation?: (toolName: string) => boolean) {
    const questions = new McpAppQuestionStore();
    const presence = new McpAppPresenceStore();
    const actions = new McpAppActionStore();
    const called: string[] = [];
    const instance = "alpha";
    const ctxId = "ctx-one";
    const endpoint = new McpAppCall({ actions, questions, presence, instance,
        toolCallResourceUriForTool: (name) => "ui://widget/toolcall.html?widgetRevision=1&toolName=" + name,
        ...(ownsPresentation === undefined ? {} : { ownsPresentation }),
        bootstrap: async () => ({ ctxId, token: "private-valid-capability-01", liveBaseUrl: "https://example.test/api/live" }),
        context: { resolve: async () => ({ status: "active", ctxId,
            environments: [{ instance, workspace: "/demo" }] }) } as never,
        dispatch: { callTool: async (name: string, input: Record<string, unknown>, _request: unknown,
            _signal?: AbortSignal, onExecuted?: (id: string, value: unknown, result: unknown) => void) => {
            called.push(name);
            if (name === "mcpapp_ask") return {
                status: "ready", question: input.question, choices: input.choices ?? [], allowText: input.allowText !== false,
            };
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
    return { questions, presence, actions, endpoint, called, request, instance, ctxId };
}

async function questionReady(questions: McpAppQuestionStore, instance: string, ctxId: string) {
    for (let i = 0; i < 100; i++) {
        const pending = questions.pending(instance, ctxId);
        if (pending.length) return pending[0]!;
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error("question not created");
}

test("mcpapp_ask blocks on the user's visible question, then receives audited MCP App answer", async () => {
    const f = fixture();
    f.presence.beginWatch(f.instance, f.ctxId);
    const waiting = f.endpoint.call("mcpapp_ask", { question: "Proceed?", choices: ["Yes", "No"], allowText: false }, f.request);
    const pending = await questionReady(f.questions, f.instance, f.ctxId);
    assert.equal(pending.question, "Proceed?");
    assert.deepEqual(pending.choices, ["Yes", "No"]);
    assert.equal(f.questions.pending(f.instance, f.ctxId).length, 1);
    const result = await f.endpoint.call("mcpapp_action", { ctxId: f.ctxId, itemId: pending.id,
        actionId: "question-answer-choice", requestId: "reply-id-00000001", input: "Yes" }, f.request);
    assert.deepEqual(result, { status: "applied", itemId: pending.id,
        actionId: "question-answer-choice", detached: false, question: "Proceed?", answer: "Yes" });
    assert.deepEqual(await waiting, { status: "answered", questionId: pending.id, answer: "Yes" });
    assert.deepEqual(f.called, ["mcpapp_ask", "mcpapp_action"]);
});

test("answer from a different Context is refused, cancelled question can be answered after detach", async () => {
    const f = fixture();
    f.presence.beginWatch(f.instance, f.ctxId);
    const controller = new AbortController();
    const wait = f.endpoint.call("mcpapp_ask", { question: "Which branch?", allowText: true }, f.request, controller.signal);
    const pending = await questionReady(f.questions, f.instance, f.ctxId);
    await assert.rejects(() => f.endpoint.call("mcpapp_action", { ctxId: "ctx-other",
        itemId: pending.id, actionId: "question-answer-text", requestId: "reply-id-00000002", input: "main" }, f.request));
    assert.equal(f.questions.pending(f.instance, f.ctxId).length, 1);
    controller.abort();
    await assert.rejects(wait, /cancelled/);
    const answer = await f.endpoint.call("mcpapp_action", { ctxId: f.ctxId, itemId: pending.id,
        actionId: "question-answer-text", requestId: "reply-id-00000003", input: "main" }, f.request);
    assert.equal((answer as Record<string, unknown>).detached, true);
    assert.equal((answer as Record<string, unknown>).answer, "main");
});

test("mcpapp_open returns private capability in protocol result", async () => {
    const f = fixture();
    const response = await f.endpoint.present("mcpapp_open", { status: "ready", ctxId: f.ctxId }, f.request);
    assert.ok(response instanceof McpNativeToolResult);
    assert.deepEqual(response.structuredContent, { status: "ready" });
    assert.equal(response._meta?.["portable-devshell/mcpapp"] &&
        (response._meta["portable-devshell/mcpapp"] as Record<string, unknown>).ctxId, f.ctxId);
});

test("MCP tool catalog routes explicit Workspace to fullscreen and ordinary calls to inline", async () => {
    const { McpEndpointCatalog } = await import("../../src/protocol/tool/Catalog.ts");
    const { McpExtensionRegistry } = await import("../../src/protocol/extension/Registry.ts");
    const { createMcpAppMcpExtension } = await import("../../src/mcpapp/Extension.ts");
    const { mcpAppOpenDefinition, mcpAppAskDefinition } =
        await import("../../../core/src/instance/mcpapp/Definition.ts");
    const extensions = new McpExtensionRegistry([createMcpAppMcpExtension("https://example.test")]);
    const definitions = [
        mcpAppOpenDefinition(), mcpAppAskDefinition(),
        { name: "environ_info", group: "environ", description: "Get environment",
            requiredCapabilities: [], inputSchema: { type: "object" }, outputSchema: { type: "object" } },
        { name: "file_read", group: "file", description: "Read file",
            requiredCapabilities: [], inputSchema: { type: "object" }, outputSchema: { type: "object" } },
        { name: "tmux_read", group: "tmux", description: "Read a task transcript",
            requiredCapabilities: [], inputSchema: { type: "object" }, outputSchema: { type: "object" } },
    ];
    const catalog = new McpEndpointCatalog({
        instanceName: "alpha",
        bootstrapPresentationResourceUri: extensions.environmentPresentation()?.resourceUri,
        interactionPresentationResourceUri: extensions.environmentPresentation()?.interactionResourceUri,
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
        if (tool.name === "tmux_read") {
            const meta = tool._meta as Record<string, unknown> | undefined;
            assert.equal(meta?.["openai/outputTemplate"], undefined);
            continue;
        }
        const uri = tool.name === "mcpapp_open" ? workspace?.uri
            : tool.name === "mcpapp_ask" ? interaction?.uri
                : toolCall?.uri + "?widgetRevision=1&toolName=" + tool.name;
        const meta = tool._meta as Record<string, unknown> | undefined;
        assert.equal(meta?.["openai/outputTemplate"], uri);
        assert.equal((meta?.ui as Record<string, unknown>)?.resourceUri, uri);
        if (tool.name !== "mcpapp_ask" && tool.name !== "mcpapp_open")
            assert.equal(meta?.["openai/widgetAccessible"], undefined);
    }
    const workspaceContent = await extensions.readResource(workspace!.uri);
    const interactionContent = await extensions.readResource(interaction!.uri);
    const toolCallContent = await extensions.readResource(toolCall!.uri);
    assert.deepEqual(workspaceContent?._meta?.["openai/ui"], { availableDisplayModes: ["fullscreen"] });
    assert.deepEqual(interactionContent?._meta?.["openai/ui"], { availableDisplayModes: ["inline"] });
    assert.deepEqual(toolCallContent?._meta?.["openai/ui"], { availableDisplayModes: ["inline"] });
    assert.match(workspaceContent?.text ?? "", /data-mcpapp-view="workspace"/u);
    assert.match(interactionContent?.text ?? "", /data-mcpapp-view="interaction"/u);
    assert.match(toolCallContent?.text ?? "", /data-mcpapp-view="toolcall"/u);
    assert.equal(extensions.listResources().length, 3);
    for (const name of ["bash_run", "file_read", "file_edit", "todo_report"]) {
        const uri = toolCall?.uri + "?widgetRevision=1&toolName=" + name;
        const content = await extensions.readResource(uri);
        assert.equal(content?.uri, uri);
        assert.match(content?.text ?? "", new RegExp('data-tool-name="' + name + '"', "u"));
        assert.match(content?.text ?? "", /<script type="module"/u);
    }
    for (const bad of [
        toolCall?.uri + "?toolName=file_read",
        toolCall?.uri + "?widgetRevision=2&toolName=file_read",
        toolCall?.uri + "?widgetRevision=1&toolName=file_read&token=secret",
        toolCall?.uri + "?widgetRevision=1&toolName=%3Cscript%3E",
    ]) assert.equal(await extensions.readResource(bad), undefined);
    assert.match(workspaceContent?.text ?? "", /<link rel="stylesheet"/u);
    assert.match(toolCallContent?.text ?? "", /<link rel="stylesheet"/u);
    for (const resource of [workspaceContent, interactionContent, toolCallContent])
        assert.equal(resource?.text?.includes("private-valid-capability-01"), false);
});

test("MCP App tags ordinary ToolCall results for an inline card without altering execution", async () => {
    const f = fixture();
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
    assert.equal(presented._meta?.["portable-devshell/toolcall"]?.name, "tmux_read");
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
    const f = fixture();
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
