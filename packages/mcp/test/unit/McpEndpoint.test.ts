import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { McpEndpointBinding, McpEndpointRequestHandler, McpEndpointWorker } from "@portable-devshell/mcp";

const fixturesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };
interface CommandResult {
    exitCode: number | null;
    stderr: string;
    stdout: string;
}
interface ToolDefinition {
    description?: string;
    inputSchema?: JsonValue;
    name: string;
}

test("initialize succeeds", async () => {
    const response = await createHandler().handle(createBinding(), await readFixture("mcp-initialize.json"));

    assert.equal(response.error, undefined);
    assert.equal(response.result?.protocolVersion, "2026-07-07");
    assert.equal(typeof response.result?.sessionId, "string");
});

test("tools/list uses allowlist filtering", async () => {
    const response = await createHandler().handle(createBinding(), await readFixture("mcp-tools-list.json"));
    const result = response.result as { tools: Array<{ name: string }> };

    assert.deepEqual(result.tools.map((tool) => tool.name), ["bash_run"]);
});

test("tools/call delegates to WorkerInstance.callTool", async () => {
    const harness = createWorkerHarness();
    const response = await createHandler().handle(createBinding(harness), await readFixture("mcp-tools-call.json"));

    assert.equal(response.error, undefined);
    assert.deepEqual(harness.calls, [{ toolName: "bash_run", input: { command: "pwd" } }]);
    assert.equal(response.result?.isError, false);
});

test("not ready maps to mcp.instanceNotReady", async () => {
    const response = await createHandler().handle(createBinding(createWorkerHarness({ ready: false })), await readFixture("mcp-tools-list.json"));

    assert.equal(response.error?.data?.code, "mcp.instanceNotReady");
});

test("schema unavailable returns mcp.toolSchemaUnavailable", async () => {
    const harness = createWorkerHarness({
        tools: [{ name: "bash_run", description: "Run shell", inputSchema: undefined }]
    });
    const response = await createHandler().handle(createBinding(harness), await readFixture("mcp-tools-list.json"));

    assert.equal(response.error?.data?.code, "mcp.toolSchemaUnavailable");
});

function createBinding(harness = createWorkerHarness()): McpEndpointBinding {
    return new McpEndpointBinding(
        new McpEndpointWorker({
            allowlist: ["bash_run"],
            instanceName: "demo",
            worker: harness.worker
        })
    );
}

function createHandler(): McpEndpointRequestHandler {
    return new McpEndpointRequestHandler();
}

async function readFixture(name: string): Promise<JsonValue> {
    return JSON.parse(await readFile(resolve(fixturesDirectory, name), "utf8")) as JsonValue;
}

function createWorkerHarness(options?: { ready?: boolean; result?: CommandResult; tools?: ToolDefinition[] }) {
    const calls: Array<{ input: JsonValue; toolName: string }> = [];
    const tools = options?.tools ?? [
        { name: "bash_run", description: "Run shell", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
        { name: "read_logs", description: "Read logs", inputSchema: { type: "object" } }
    ];
    const ready = options?.ready ?? true;
    const result = options?.result ?? { exitCode: 0, stderr: "", stdout: "/workspace\n" };

    return {
        calls,
        worker: {
            snapshot() {
                return { ready };
            },
            listTools() {
                return tools;
            },
            async callTool(toolName: string, input: JsonValue) {
                if (!ready) {
                    const error = new Error("not ready");
                    Object.assign(error, {
                        code: "core.instanceNotReady",
                        details: { toolName },
                        retryable: false
                    });
                    throw error;
                }

                calls.push({ toolName, input });
                return result;
            }
        }
    } as const;
}
