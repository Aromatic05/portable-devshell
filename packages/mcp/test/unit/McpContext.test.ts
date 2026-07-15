import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { McpContextRegistry, McpEndpointWorker } from "@portable-devshell/mcp";
import type { JsonValue, ToolCallContext, ToolDefinition } from "@portable-devshell/shared";

const bashRun: ToolDefinition = {
    description: "Run a shell command.",
    group: "bash",
    inputSchema: {
        additionalProperties: false,
        properties: { command: { type: "string" } },
        required: ["command"],
        type: "object"
    },
    name: "bash_run",
    outputSchema: { type: "object" },
    requiredCapabilities: ["execute"]
};

test("McpContextRegistry persists active contexts and renews their sliding expiry", async () => {
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-context-"));
    const filePath = join(root, "contexts.json");
    let now = Date.parse("2026-07-15T00:00:00.000Z");

    try {
        const registry = new McpContextRegistry({
            filePath,
            idFactory: () => "ctx-persisted",
            now: () => now,
            ttlMs: 60_000
        });
        await registry.initialize();
        const created = await registry.create({
            instance: "demo-local",
            principal: "local",
            workspace: "/workspace"
        });
        assert.equal(created.ctxId, "ctx-persisted");
        assert.equal(created.expiresAt, "2026-07-15T00:01:00.000Z");

        now += 30_000;
        const renewed = await registry.validateAndTouch("ctx-persisted", {
            instance: "demo-local",
            principal: "local",
            workspace: "/workspace"
        });
        assert.equal(renewed.expiresAt, "2026-07-15T00:01:30.000Z");

        const reloaded = new McpContextRegistry({ filePath, now: () => now, ttlMs: 60_000 });
        await reloaded.initialize();
        assert.equal(
            (await reloaded.validateAndTouch("ctx-persisted", {
                instance: "demo-local",
                principal: "local",
                workspace: "/workspace"
            })).ctxId,
            "ctx-persisted"
        );
        assert.match(await readFile(filePath, "utf8"), /ctx-persisted/u);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry distinguishes invalid and expired ctxId values", async () => {
    let now = 1_000;
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-expiring",
        now: () => now,
        ttlMs: 100
    });
    await registry.initialize();
    const binding = { instance: "demo-local", principal: "local", workspace: "/workspace" };
    await registry.create(binding);

    await assert.rejects(registry.validateAndTouch("ctx-missing", binding), hasCode("mcp.contextInvalid"));
    await assert.rejects(
        registry.validateAndTouch("ctx-expiring", { ...binding, principal: "other" }),
        hasCode("mcp.contextInvalid")
    );

    now = 1_101;
    await assert.rejects(registry.validateAndTouch("ctx-expiring", binding), hasCode("mcp.contextExpired"));
    await assert.rejects(registry.validateAndTouch("ctx-expiring", binding), hasCode("mcp.contextExpired"));
});

test("McpEndpointWorker exposes environ_info and requires ctxId on every other tool", async () => {
    const registry = new McpContextRegistry({ idFactory: () => "ctx-created" });
    await registry.initialize();
    const calls: Array<{ context: ToolCallContext; input: JsonValue; toolName: string }> = [];
    const endpoint = new McpEndpointWorker({
        contextRegistry: registry,
        instanceName: "demo-local",
        policy: { capabilities: ["execute"], groups: ["bash"] },
        worker: {
            async auditToolCall<T extends JsonValue>(
                _toolName: string,
                _input: JsonValue,
                _context: ToolCallContext,
                operation: () => Promise<T>
            ): Promise<T> { return await operation(); },
            async appendMcpSessionClosed() {},
            async appendMcpSessionOpened() {},
            async appendMcpToolCalled() {},
            async callTool(toolName, input, context) {
                calls.push({ context, input, toolName });
                return { ok: true };
            },
            handshake: {
                capabilities: { cancel: true, streaming: false, tools: true },
                instance: "demo-local",
                platform: {
                    arch: "x86_64",
                    distribution: { id: "arch", name: "Arch Linux", version: "rolling" },
                    os: "linux",
                    packageManager: "pacman",
                    shell: { executable: "/bin/bash", kind: "bash", version: "5.3" }
                },
                protocolVersion: 1,
                workerVersion: "0.4.1",
                workspace: "/workspace"
            },
            listTools: () => [bashRun],
            snapshot: () => ({ ready: true })
        }
    });

    const tools = endpoint.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["environ_info", "bash_run"]);
    const bashSchema = tools[1]?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    assert.ok(bashSchema.properties?.ctxId);
    assert.deepEqual(bashSchema.required, ["command", "ctxId"]);

    const environment = await endpoint.callTool("environ_info", {}, { principal: "local", requestId: "env" });
    const environmentRecord = environment as Record<string, JsonValue>;
    assert.equal(environmentRecord.ctxId, "ctx-created");
    assert.equal(typeof environmentRecord.expiresAt, "string");
    assert.equal(environmentRecord.instance, "demo-local");
    assert.equal(environmentRecord.workspace, "/workspace");
    assert.deepEqual(environmentRecord.platform, {
        arch: "x86_64",
        distribution: { id: "arch", name: "Arch Linux", version: "rolling" },
        os: "linux",
        packageManager: "pacman",
        shell: "bash"
    });

    await assert.rejects(
        endpoint.callTool("bash_run", { command: "pwd" }, { principal: "local", requestId: "missing" }),
        hasCode("mcp.contextInvalid")
    );
    await endpoint.callTool(
        "bash_run",
        { command: "pwd", ctxId: "ctx-created" },
        { principal: "local", requestId: "run" }
    );
    assert.deepEqual(calls, [
        {
            context: { ctxId: "ctx-created", requestId: "run", source: "mcp" },
            input: { command: "pwd" },
            toolName: "bash_run"
        }
    ]);
});

function hasCode(expected: string): (error: unknown) => boolean {
    return (error: unknown) => {
        assert.equal((error as { code?: string }).code, expected);
        return true;
    };
}

test("only environ_info omits ctxId across the complete 24-tool endpoint catalog", () => {
    const workerToolNames = [
        "artifact_read",
        "bash_run",
        "file_find",
        "file_info",
        "file_read",
        "file_search",
        "file_edit",
        "tmux_create",
        "tmux_run",
        "tmux_read",
        "tmux_input",
        "tmux_close",
        "tmux_inspect",
        "tmux_list"
    ];
    const endpoint = new McpEndpointWorker({
        gateway: {
            assertReady() {},
            async callTool() { return {}; },
            async createSshInstance(_source, input) { return { name: input.name }; },
            async listInstances() { return []; },
            listTools() { return []; },
            async readTodo() { return { items: [], revision: 0, summary: { completed: 0, total: 0 } }; },
            async shareArtifact() { return {}; },
            async startInstance(instance) { return { instance }; },
            async statusInstance(instance) { return { instance }; },
            async stopInstance(instance) { return { instance }; },
            async transferArtifact() { return {}; },
            async writeTodo() { return { items: [], revision: 1, summary: { completed: 0, total: 0 } }; }
        },
        instanceName: "demo-local",
        policy: {
            capabilities: ["read", "write", "execute", "manage"],
            groups: ["artifact", "bash", "file", "instance", "tmux", "todo"]
        },
        worker: {
            async auditToolCall<T extends JsonValue>(
                _toolName: string,
                _input: JsonValue,
                _context: ToolCallContext,
                operation: () => Promise<T>
            ): Promise<T> { return await operation(); },
            async appendMcpSessionClosed() {},
            async appendMcpSessionOpened() {},
            async appendMcpToolCalled() {},
            async callTool() { return {}; },
            listTools: () => workerToolNames.map((name) => ({
                description: name,
                group: name.split("_", 1)[0]!,
                inputSchema: { additionalProperties: false, properties: {}, type: "object" },
                name,
                outputSchema: { type: "object" },
                requiredCapabilities: []
            })),
            snapshot: () => ({ ready: true })
        }
    });

    const tools = endpoint.listTools();
    assert.equal(tools.length, 24);
    assert.equal(tools[0]?.name, "environ_info");
    assert.equal(
        tools[0]?.description,
        "Initialize the session context and return the target environment. Call once at the start of each session and include the returned ctxId in every later tool call. Reuse it until a tool explicitly reports that it has expired, then call environ_info again. If it is lost or rejected as invalid, stop and ask the user for instructions."
    );
    for (const tool of tools) {
        assert.doesNotMatch(tool.description, /Pass the ctxId returned by environ_info|Exposed by portable-devshell MCP|Set instance to route/u);
        const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
        if (tool.name === "environ_info") {
            assert.equal(schema.properties?.ctxId, undefined);
            assert.equal(schema.required?.includes("ctxId") ?? false, false);
            continue;
        }
        assert.notEqual(schema.properties?.ctxId, undefined, tool.name);
        assert.equal(schema.required?.includes("ctxId"), true, tool.name);
    }
});
