import assert from "node:assert/strict";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { WorkerTransportDriverLocal, WorkerBinary, WorkerInstanceFactory } from "@portable-devshell/core/testing";
import { McpHost } from "@portable-devshell/mcp/testing";
import { asInstanceName, asWorkspacePath } from "@portable-devshell/shared";
import { resolveTestWorkerBinary, tmuxTestOptions } from "../../../../test/TestPlatformSupport.ts";

const workerBinaryPath = resolveTestWorkerBinary();

type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

test("MCP tmux supports a complete interactive lifecycle when JSON-RPC request ids are reused", tmuxTestOptions(workerBinaryPath), async () => {
    await withTmuxHarness("aromatic-mcp-tmux-lifecycle", async ({ callTool, createContext, listTools }) => {
        const tools = await listTools();
        for (const toolName of ["tmux_run", "tmux_input", "tmux_read"]) {
            const tool = tools.find((entry) => entry.name === toolName);
            assert.notEqual(tool, undefined);
            assert.equal(tool?.inputSchema.properties?.timeMs?.minimum, 0);
            assert.equal(tool?.inputSchema.properties?.timeMs?.maximum, 300_000);
        }
        const ctxId = await createContext();
        const requestId = "reused-tools-call-id";
        const created = await callTool(requestId, "tmux_create", { ctxId, name: "interactive" });
        assert.equal(created.error, undefined, JSON.stringify(created));

        const run = await callTool(requestId, "tmux_run", {
            command: "read -r value; printf 'received:%s\\n' \"$value\"",
            ctxId,
            pane: "interactive",
            wait: "nonblock"
        });
        assert.equal(run.error, undefined, JSON.stringify(run));
        const task = readString(run.result?.structuredContent?.task?.id, "tmux_run task id");

        const input = await callTool(requestId, "tmux_input", {
            ctxId,
            input: "hello^M",
            line: 100,
            task,
            timeMs: 1000
        });
        assert.equal(input.error, undefined, JSON.stringify(input));
        const output = [...(input.result?.structuredContent?.output ?? [])];

        const finished = await waitForTask(callTool, requestId, ctxId, task);
        output.push(...finished.output);
        assert.notEqual(finished.task.status, "running");
        assert.equal(
            output.some((line) => line.includes("received:hello")),
            true,
            JSON.stringify({ finished, output })
        );

        const closed = await callTool(requestId, "tmux_close", {
            ctxId,
            pane: "interactive"
        });
        assert.equal(closed.error, undefined, JSON.stringify(closed));
        assert.equal(closed.result?.structuredContent?.closedPaneId, created.result?.structuredContent?.pane?.id);
    });
});

test("MCP tmux rejects foreign control while the owner can recover and close with a reused request id", tmuxTestOptions(workerBinaryPath), async () => {
    await withTmuxHarness("aromatic-mcp-tmux-ownership", async ({ callTool, createContext }) => {
        const ownerCtxId = await createContext();
        const foreignCtxId = await createContext();
        const requestId = "reused-tools-call-id";
        const created = await callTool(requestId, "tmux_create", {
            ctxId: ownerCtxId,
            name: "owned"
        });
        assert.equal(created.error, undefined, JSON.stringify(created));

        const run = await callTool(requestId, "tmux_run", {
            command: "sleep 10",
            ctxId: ownerCtxId,
            pane: "owned",
            wait: "nonblock"
        });
        assert.equal(run.error, undefined, JSON.stringify(run));
        const task = readString(run.result?.structuredContent?.task?.id, "tmux_run task id");

        const foreignInput = await callTool(requestId, "tmux_input", {
            ctxId: foreignCtxId,
            input: "^C",
            task
        });
        assert.equal(foreignInput.error?.data?.code, "tmux.taskLocked", JSON.stringify(foreignInput));

        const foreignClose = await callTool(requestId, "tmux_close", {
            ctxId: foreignCtxId,
            force: true,
            pane: "owned"
        });
        assert.equal(foreignClose.error?.data?.code, "tmux.taskLocked", JSON.stringify(foreignClose));

        const ownerInput = await callTool(requestId, "tmux_input", {
            ctxId: ownerCtxId,
            input: "^C",
            task,
            timeMs: 1000
        });
        assert.equal(ownerInput.error, undefined, JSON.stringify(ownerInput));
        const finished = await waitForTask(callTool, requestId, ownerCtxId, task);
        assert.notEqual(finished.task.status, "running");

        const ownerClose = await callTool(requestId, "tmux_close", {
            ctxId: ownerCtxId,
            pane: "owned"
        });
        assert.equal(ownerClose.error, undefined, JSON.stringify(ownerClose));
        assert.equal(ownerClose.result?.structuredContent?.closedPaneId, created.result?.structuredContent?.pane?.id);
    });
});

interface ToolResponse {
    error?: { data?: { code?: string } };
    result?: {
        structuredContent?: {
            closedPaneId?: string;
            output?: string[];
            pane?: { id?: string };
            task?: { id?: string; status?: string };
        };
    };
}

interface TmuxHarness {
    callTool(requestId: string, name: string, args: Record<string, JsonValue>): Promise<ToolResponse>;
    createContext(): Promise<string>;
    listTools(): Promise<Array<{
        inputSchema: { properties?: { timeMs?: { maximum?: number; minimum?: number } } };
        name: string;
    }>>;
}

async function withTmuxHarness(instanceName: string, body: (harness: TmuxHarness) => Promise<void>): Promise<void> {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-mcp-tmux-home-"));
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-mcp-tmux-runtime-"));
    const workspacePath = await mkdtemp(join(tmpdir(), "portable-devshell-mcp-tmux-workspace-"));
    const instance = new WorkerInstanceFactory().create({
        defaultWorkspace: asWorkspacePath(workspacePath),
        env: {
            ...process.env,
            HOME: homeDirectory,
            XDG_RUNTIME_DIR: runtimeDirectory
        },
        homeDirectory,
        name: asInstanceName(instanceName),
        transport: new WorkerTransportDriverLocal({
            spawnFunction: nodeSpawn,
            workerBinary: new WorkerBinary(workerBinaryPath!)
        })
    });
    const host = new McpHost({
        auth: { enabled: false, provider: "none" },
        instances: [{
            name: instanceName,
            policy: { capabilities: ["execute", "read"], groups: ["tmux"] },
            worker: instance
        }],
        listenHost: "127.0.0.1",
        listenPort: 0
    });

    try {
        await instance.start();
        await host.start();
        const address = host.server.address;
        assert.notEqual(address, null);
        assert.equal(typeof address, "object");
        const endpoint = `http://127.0.0.1:${address.port}/${instanceName}/mcp`;
        const initialize = await postJson(endpoint, {
            id: "initialize",
            jsonrpc: "2.0",
            method: "initialize",
            params: {
                capabilities: {},
                clientInfo: { name: "tmux-contract-test", version: "1" },
                protocolVersion: "2025-06-18"
            }
        });
        assert.equal(initialize.error, undefined, JSON.stringify(initialize));
        const headers = {
            "mcp-protocol-version": String(initialize.result?.protocolVersion ?? ""),
            "mcp-session-id": String(initialize.headers.get("mcp-session-id") ?? "")
        };
        assert.notEqual(headers["mcp-session-id"], "");
        const initialized = await postRawJson(endpoint, {
            jsonrpc: "2.0",
            method: "notifications/initialized"
        }, headers);
        assert.equal(initialized.status, 202);

        const callTool = async (requestId: string, name: string, args: Record<string, JsonValue>): Promise<ToolResponse> =>
            await postJson(endpoint, {
                id: requestId,
                jsonrpc: "2.0",
                method: "tools/call",
                params: { arguments: args, name }
            }, headers) as ToolResponse;
        const createContext = async (): Promise<string> => {
            const response = await callTool("reused-environ-id", "environ_info", {});
            assert.equal(response.error, undefined, JSON.stringify(response));
            return readString(response.result?.structuredContent?.ctxId, "environ_info ctxId");
        };
        const listTools = async () => {
            const response = await postJson(endpoint, {
                id: "list-tools",
                jsonrpc: "2.0",
                method: "tools/list"
            }, headers);
            return response.result?.tools as Array<{
                inputSchema: { properties?: { timeMs?: { maximum?: number; minimum?: number } } };
                name: string;
            }>;
        };

        await body({ callTool, createContext, listTools });
    } finally {
        await host.stop().catch(() => undefined);
        await instance.stop().catch(() => undefined);
        await instance.close().catch(() => undefined);
        const tmuxSocket = join(runtimeDirectory, "devshell-worker", instanceName, "tmux.sock");
        spawnSync("tmux", ["-S", tmuxSocket, "kill-server"], { stdio: "ignore" });
        await rm(homeDirectory, { force: true, recursive: true });
        await rm(runtimeDirectory, { force: true, recursive: true });
        await rm(workspacePath, { force: true, recursive: true });
    }
}

async function waitForTask(
    callTool: TmuxHarness["callTool"],
    requestId: string,
    ctxId: string,
    task: string
): Promise<{ output: string[]; task: { status: string } }> {
    const output: string[] = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await callTool(requestId, "tmux_read", {
            ctxId,
            line: 200,
            task,
            timeMs: 100
        });
        assert.equal(response.error, undefined, JSON.stringify(response));
        output.push(...(response.result?.structuredContent?.output ?? []));
        const status = readString(response.result?.structuredContent?.task?.status, "tmux_read task status");
        if (status !== "running") {
            return { output, task: { status } };
        }
    }
    throw new Error(`Timed out waiting for tmux task ${task}`);
}

function readString(value: unknown, name: string): string {
    assert.equal(typeof value, "string", `${name} must be a string`);
    return value;
}

async function postJson(url: string, body: JsonValue, extraHeaders?: Record<string, string>) {
    const response = await postRawJson(url, body, extraHeaders);
    assert.equal(response.status, 200, response.text);
    return {
        headers: response.headers,
        ...JSON.parse(response.text) as Record<string, unknown>
    };
}

async function postRawJson(url: string, body: JsonValue, extraHeaders?: Record<string, string>) {
    const response = await fetch(url, {
        body: JSON.stringify(body),
        headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            ...extraHeaders
        },
        method: "POST"
    });
    return {
        headers: response.headers,
        status: response.status,
        text: await response.text()
    };
}
