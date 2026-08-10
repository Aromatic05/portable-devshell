import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { McpContextRegistry, McpEndpointWorker, McpHost } from "@portable-devshell/mcp/testing";
import type { JsonValue, ToolCallContext, ToolDefinition } from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

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
    const root = await createTestTempDirectory("context");
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
            principal: "local"
        });
        assert.equal(renewed.expiresAt, "2026-07-15T00:01:30.000Z");

        const reloaded = new McpContextRegistry({ filePath, now: () => now, ttlMs: 60_000 });
        await reloaded.initialize();
        assert.equal(
            (await reloaded.validateAndTouch("ctx-persisted", {
                instance: "demo-local",
                principal: "local"
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

test("McpContextRegistry lists contexts and supports manual disable and renew", async () => {
    const now = 1_000;
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-managed",
        now: () => now,
        ttlMs: 100
    });
    await registry.initialize();
    const binding = { instance: "demo-local", principal: "local", workspace: "/workspace" };
    await registry.create(binding);

    const listed = await registry.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.ctxId, "ctx-managed");
    assert.equal(listed[0]?.status, "active");

    const renewed = await registry.renew("ctx-managed");
    assert.equal(renewed.status, "active");
    assert.equal(renewed.expiresAt, "1970-01-01T00:00:01.100Z");

    const disabled = await registry.disable("ctx-managed");
    assert.equal(disabled.status, "disabled");
    await assert.rejects(
        registry.validateAndTouch("ctx-managed", binding),
        hasCode("mcp.contextDisabled")
    );
    await assert.rejects(registry.renew("ctx-managed"), hasCode("mcp.contextDisabled"));
    assert.equal((await registry.list())[0]?.status, "disabled");
});

test("McpHost context admin releases alerts only after the last workspace context is disabled", async () => {
    const released: string[] = [];
    const touched: string[] = [];
    const host = new McpHost({
        instances: [{
            name: "demo-local",
            policy: { capabilities: [], groups: [] },
            worker: {
                async releaseAlerts(workspace: string) { released.push(workspace); },
                snapshot: () => ({ ready: true }),
                async touchAlerts(workspace: string) { touched.push(workspace); },
            } as never,
        }],
        listenHost: "127.0.0.1",
        listenPort: 0,
    });
    await host.contextRegistry.initialize();
    const first = await host.contextRegistry.create({
        instance: "demo-local",
        principal: "local",
        workspace: "/projects/alpha",
    });
    const second = await host.contextRegistry.create({
        instance: "demo-local",
        principal: "local",
        workspace: "/projects/alpha",
    });

    await host.contextAdmin.disable(first.ctxId);
    assert.deepEqual(released, []);
    await host.contextAdmin.disable(second.ctxId);
    assert.deepEqual(released, ["/projects/alpha"]);

    const renewed = await host.contextRegistry.create({
        instance: "demo-local",
        principal: "local",
        workspace: "/projects/beta",
    });
    await host.contextAdmin.renew(renewed.ctxId);
    assert.deepEqual(touched, ["/projects/beta"]);
});

test("McpEndpointWorker exposes environ_info and requires ctxId on every other tool", async () => {
    const registry = new McpContextRegistry({ idFactory: () => "ctx-created" });
    await registry.initialize();
    const calls: Array<{ context: ToolCallContext; input: JsonValue; toolName: string }> = [];
    const touchedAlertWorkspaces: string[] = [];
    const touchedTemporaryDirectories: string[] = [];
    const endpoint = new McpEndpointWorker({
        contextRegistry: registry,
        instanceName: "demo-local",
        policy: { capabilities: ["execute"], groups: ["bash"] },
        worker: {
            async auditToolCall<T extends JsonValue>(
                _toolName: string,
                _input: JsonValue,
                _context: ToolCallContext,
                operation: (callId: string) => Promise<T>
            ): Promise<T> { return await operation("call-test"); },
            async appendMcpSessionClosed() {},
            async appendMcpSessionOpened() {},
            async appendMcpToolCalled() {},
            async callTool(toolName, input, context) {
                calls.push({ context, input, toolName });
                return { ok: true };
            },
            handshake: {
                instance: "demo-local",
                skillsDirectory: "/home/demo/.devshell/skill",
                platform: {
                    arch: "x86_64",
                    distribution: { id: "arch", name: "Arch Linux", version: "rolling" },
                    os: "linux",
                    packageManager: "pacman",
                    shell: { executable: "/bin/bash", kind: "bash", version: "5.3" }
                },
                workspace: "/workspace"
            },
            listTools: () => [bashRun],
            async prepareWorkspace(workspace) {
                return {
                    projectMemoryAgentFile: `${workspace}/.memory/AGENT.md`,
                    projectMemoryDirectory: `${workspace}/.memory`,
                    temporaryDirectory: "/tmp/demo-local-123456",
                    workspace
                };
            },
            async readAlerts() {
                return { advice: [{ code: "worker.memory.high", text: "Worker memory is high." }] };
            },
            async touchAlerts(workspace) {
                touchedAlertWorkspaces.push(workspace);
            },
            async touchTemporaryDirectory(path) {
                touchedTemporaryDirectories.push(path);
            },
            snapshot: () => ({ ready: true })
        }
    });

    const tools = endpoint.listTools();
    const bashSchema = tools.find((tool) => tool.name === "bash_run")?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    assert.ok(bashSchema.properties?.ctxId);
    assert.equal(bashSchema.required?.includes("ctxId"), true);
    assert.equal(bashSchema.required?.includes("command"), true);

    const environment = await endpoint.callTool(
        "environ_info",
        { workspace: "/projects/alpha" },
        { principal: "local", requestId: "env" }
    );
    const environmentRecord = environment as Record<string, JsonValue>;
    assert.equal(environmentRecord.ctxId, "ctx-created");
    assert.equal(typeof environmentRecord.expiresAt, "string");
    assert.equal(environmentRecord.instance, "demo-local");
    assert.equal(environmentRecord.skillsDirectory, "/home/demo/.devshell/skill");
    assert.equal(environmentRecord.workspace, "/projects/alpha");
    assert.equal(environmentRecord.projectMemoryAgentFile, "/projects/alpha/.memory/AGENT.md");
    assert.equal(environmentRecord.projectMemoryDirectory, "/projects/alpha/.memory");
    assert.equal(environmentRecord.temporaryDirectory, "/tmp/demo-local-123456");
    assert.deepEqual(environmentRecord.comment, [
        "Read /projects/alpha/.memory/AGENT.md before working.",
        "Use /projects/alpha/.memory for durable project memory; keep it useful for future sessions.",
        "Use /tmp/demo-local-123456 for all temporary files.",
        "Worker memory is high."
    ]);
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
            context: { ctxId: "ctx-created", requestId: "run", source: "mcp", workspace: "/projects/alpha" },
            input: { command: "pwd" },
            toolName: "bash_run"
        }
    ]);
    assert.deepEqual(touchedAlertWorkspaces, ["/projects/alpha"]);
    assert.deepEqual(touchedTemporaryDirectories, ["/tmp/demo-local-123456"]);
});

function hasCode(expected: string): (error: unknown) => boolean {
    return (error: unknown) => {
        assert.equal((error as { code?: string }).code, expected);
        return true;
    };
}
