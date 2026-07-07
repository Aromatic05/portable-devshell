import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { McpEndpointBinding, McpEndpointRequestHandler, McpEndpointWorker } from "@portable-devshell/mcp";

const fixturesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

test("tools/call goes through WorkerInstance", async () => {
    const calls: string[] = [];
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
                async callTool(toolName: string) {
                    calls.push(toolName);
                    return { exitCode: 0, stderr: "", stdout: "done\n" };
                }
            } as never
        })
    );

    const response = await new McpEndpointRequestHandler().handle(binding, await readFixture("mcp-tools-call.json"));

    assert.deepEqual(calls, ["bash_run"]);
    assert.equal(response.error, undefined);
});

async function readFixture(name: string): Promise<JsonValue> {
    return JSON.parse(await readFile(resolve(fixturesDirectory, name), "utf8")) as JsonValue;
}
