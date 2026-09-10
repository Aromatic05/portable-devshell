import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";

import { parseExtensionManifest } from "@portable-devshell/extension";

import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import type { McpClientFactory, McpClientPort } from "../../src/builtin/McpClientRuntime.ts";
import { executeMcpCommand, executeMcpModelCommand, type McpCommandRuntime } from "../../src/builtin/McpCommand.ts";
import { McpProfileStore } from "../../src/builtin/McpProfileStore.ts";

function invocation(localOwner = true) {
    return {
        localOwner,
        requestId: "request-1",
        signal: new AbortController().signal
    };
}

function modelInvocation() {
    return {
        context: {
            async instanceReference() { return { current: true }; }
        },
        instance: "local-test",
        requestId: "model-request",
        signal: new AbortController().signal,
        workspace: "/workspace"
    };
}

test("MCP Extension manifest exposes separate native and model command surfaces without host-managed capabilities", async () => {
    const manifest = parseExtensionManifest(JSON.parse(
        await readFile(new URL("../../src/builtin/devshell-extension.json", import.meta.url), "utf8")
    ));
    assert.equal(manifest.id, "mcp");
    assert.equal(manifest.apiVersion, 4);
    assert.deepEqual(manifest.capabilities, []);
    assert.deepEqual(manifest.extensions, {
        "cli.native-commands": [{
            id: "mcp",
            summary: "Manage MCP client profiles and requests",
            title: "MCP Client",
            usage: "mcp <command>"
        }],
        "cli.model-commands": [{
            id: "mcp",
            summary: "Inspect MCP profiles and call their tools",
            title: "MCP Client",
            usage: "mcp <list|get|tools|call>"
        }]
    });
});

test("MCP command owns profile CRUD and restricts mutations to the local owner", async (t) => {
    const root = await createTestTempDirectory("mcp-command-profile");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const runtime = fakeRuntime(new McpProfileStore(root), []);

    assert.deepEqual(await executeMcpCommand(runtime, ["add", "demo", "https://example.com/mcp"], invocation()), {
        kind: "json",
        value: { name: "demo", url: "https://example.com/mcp" }
    });
    assert.deepEqual(await executeMcpCommand(runtime, ["list"], invocation(false)), {
        kind: "json",
        value: [{ name: "demo", url: "https://example.com/mcp" }]
    });
    assert.deepEqual(await executeMcpCommand(runtime, ["get", "demo"], invocation(false)), {
        kind: "json",
        value: { name: "demo", url: "https://example.com/mcp" }
    });
    await assert.rejects(
        executeMcpCommand(runtime, ["remove", "demo"], invocation(false)),
        /restricted to the local owner/u
    );
    assert.deepEqual(await executeMcpCommand(runtime, ["remove", "demo"], invocation()), {
        kind: "json",
        value: { name: "demo", url: "https://example.com/mcp" }
    });
});

test("MCP command opens one client per tools/call operation, forwards cancellation, and closes it", async (t) => {
    const root = await createTestTempDirectory("mcp-command-client");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const events: string[] = [];
    const profiles = new McpProfileStore(root);
    await profiles.add({ name: "demo", url: "https://example.com/mcp" });
    const runtime = fakeRuntime(profiles, events);
    const ctx = invocation();

    assert.deepEqual(await executeMcpCommand(runtime, ["tools", "demo"], ctx), {
        kind: "json",
        value: { tools: [{ name: "echo" }] }
    });
    assert.deepEqual(await executeMcpCommand(runtime, ["call", "demo", "echo", "{\"text\":\"hello\"}"], ctx), {
        kind: "json",
        value: { content: [{ text: "hello", type: "text" }] }
    });
    assert.deepEqual(events, [
        "connect:demo",
        "tools:same-signal",
        "close",
        "connect:demo",
        "call:echo:{\"text\":\"hello\"}:same-signal",
        "close"
    ]);
});

test("MCP model command can inspect/call configured profiles but cannot mutate them", async (t) => {
    const root = await createTestTempDirectory("mcp-model-command");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const profiles = new McpProfileStore(root);
    await profiles.add({ name: "demo", url: "https://example.com/mcp" });
    const runtime = fakeRuntime(profiles, []);

    assert.deepEqual(await executeMcpModelCommand(runtime, ["tools", "demo"], modelInvocation()), {
        kind: "json",
        value: { tools: [{ name: "echo" }] }
    });
    await assert.rejects(
        executeMcpModelCommand(runtime, ["remove", "demo"], modelInvocation()),
        /native owner CLI/u
    );
});

function fakeRuntime(profiles: McpProfileStore, events: string[]): McpCommandRuntime {
    let connectSignal: AbortSignal | undefined;
    const clients: McpClientFactory = {
        async connect(profile, signal): Promise<McpClientPort> {
            connectSignal = signal;
            events.push(`connect:${profile.name}`);
            return {
                async callTool(name, input, requestSignal) {
                    events.push(`call:${name}:${JSON.stringify(input)}:${requestSignal === connectSignal ? "same-signal" : "other-signal"}`);
                    return { content: [{ text: String(input.text ?? ""), type: "text" }] };
                },
                async close() { events.push("close"); },
                async listTools(requestSignal) {
                    events.push(`tools:${requestSignal === connectSignal ? "same-signal" : "other-signal"}`);
                    return { tools: [{ name: "echo" }] };
                }
            };
        }
    };
    return { clients, profiles };
}
