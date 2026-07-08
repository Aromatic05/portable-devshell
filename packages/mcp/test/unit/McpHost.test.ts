import assert from "node:assert/strict";
import test from "node:test";

import { McpEndpointBinding, McpEndpointWorker, McpHostRouteMatcher, McpHostRouteRegistry } from "@portable-devshell/mcp";

test("/<instance>/mcp route matches", () => {
    const matcher = new McpHostRouteMatcher();
    assert.deepEqual(matcher.match("/demo/mcp"), { instanceName: "demo" });
});

test("missing instance segment does not match", () => {
    const matcher = new McpHostRouteMatcher();
    assert.equal(matcher.match("//mcp"), undefined);
});

test("route registry resolves per-instance binding", () => {
    const registry = new McpHostRouteRegistry();
    const binding = new McpEndpointBinding(
        new McpEndpointWorker({
            allowlist: ["bash_run"],
            instanceName: "demo",
            worker: {
                snapshot() {
                    return { ready: true };
                },
                listTools() {
                    return [{ name: "bash_run", description: "Run shell", inputSchema: { type: "object" } }];
                },
                async callTool(_toolName: string, _input: unknown, _context: { source: "mcp" }) {
                    return { exitCode: 0, stderr: "", stdout: "" };
                }
            } as never
        })
    );

    registry.register(binding);
    assert.equal(registry.resolve("demo"), binding);
});
