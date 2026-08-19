import assert from "node:assert/strict";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { requireTcpPort } from "../../../../test/TestHttpSupport.ts";

import { WorkerTransportDriverLocal, WorkerBinary, WorkerInstanceFactory } from "@portable-devshell/core/testing";
import { McpHost } from "@portable-devshell/mcp/testing";
import { asInstanceName } from "@portable-devshell/shared";
import { resolveTestWorkerBinary, tmuxTestOptions } from "../../../../test/TestPlatformSupport.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

const workerBinaryPath = resolveTestWorkerBinary();

type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

test("MCP tmux supports a complete interactive lifecycle when JSON-RPC request ids are reused", tmuxTestOptions(workerBinaryPath), async () => {
    await withTmuxHarness("aromatic-mcp-tmux-lifecycle", async ({ callTool, createContext, listTools }) => {
        const tools = await listTools();
        for (const toolName of ["tmux_run", "tmux_read"]) {
            const tool = tools.find((entry) => entry.name === toolName);
            assert.notEqual(tool, undefined);
            assert.equal(tool?.inputSchema.properties?.timeMs?.minimum, 0);
            assert.equal(tool?.inputSchema.properties?.timeMs?.maximum, 300_000);
        }
        const inputTool = tools.find((entry) => entry.name === "tmux_input");
        assert.equal(inputTool?.inputSchema.type, "object");
        assert.equal(inputTool?.inputSchema.anyOf, undefined);
        assert.equal(inputTool?.inputSchema.oneOf, undefined);
        for (const property of ["ctxId", "input", "task", "pane", "timeMs", "line"]) {
            assert.notEqual(inputTool?.inputSchema.properties?.[property], undefined, property);
        }
        assert.equal(inputTool?.inputSchema.required?.includes("ctxId"), true);
        assert.equal(inputTool?.inputSchema.required?.includes("input"), true);
        const ctxId = await createContext();
        const requestId = "reused-tools-call-id";
        const created = await callTool(requestId, "tmux_create", { ctxId, name: "interactive" });
        assert.equal(created.error, undefined, JSON.stringify(created));

        const run = await callTool(requestId, "tmux_run", {
            command: "read -r value; printf 'received:%s\\n' \"$value\"",
            ctxId,
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

test("MCP tmux lets a refreshed context continue a task while preserving busy checks", tmuxTestOptions(workerBinaryPath), async () => {
    await withTmuxHarness("aromatic-mcp-tmux-cross-context", async ({ callTool, createContext }) => {
        const firstCtxId = await createContext();
        const refreshedCtxId = await createContext();
        const requestId = "reused-tools-call-id";
        const created = await callTool(requestId, "tmux_create", {
            ctxId: firstCtxId,
            name: "continued"
        });
        assert.equal(created.error, undefined, JSON.stringify(created));

        const run = await callTool(requestId, "tmux_run", {
            command: "sleep 10",
            ctxId: firstCtxId,
            wait: "nonblock"
        });
        assert.equal(run.error, undefined, JSON.stringify(run));
        assert.equal(run.result?.structuredContent?.pane?.ownedByCurrentContext, undefined);
        const task = readString(run.result?.structuredContent?.task?.id, "tmux_run task id");

        const read = await callTool(requestId, "tmux_read", {
            ctxId: refreshedCtxId,
            task
        });
        assert.equal(read.error, undefined, JSON.stringify(read));

        const foreground = await callTool(requestId, "tmux_input", {
            ctxId: refreshedCtxId,
            input: "sleep 10^M",
            pane: "continued"
        });
        assert.equal(foreground.error, undefined, JSON.stringify(foreground));
        await new Promise((resolve) => setTimeout(resolve, 100));

        const busyClose = await callTool(requestId, "tmux_close", {
            ctxId: refreshedCtxId,
            pane: "continued"
        });
        assert.equal(busyClose.error?.data?.code, "tmux.paneBusy", JSON.stringify(busyClose));

        const interrupted = await callTool(requestId, "tmux_input", {
            ctxId: refreshedCtxId,
            input: "^C",
            task,
            timeMs: 1000
        });
        assert.equal(interrupted.error, undefined, JSON.stringify(interrupted));
        const finished = await waitForTask(callTool, requestId, refreshedCtxId, task);
        assert.notEqual(finished.task.status, "running");

        const stopForeground = await callTool(requestId, "tmux_input", {
            ctxId: refreshedCtxId,
            input: "^C",
            pane: "continued"
        });
        assert.equal(stopForeground.error, undefined, JSON.stringify(stopForeground));
        await new Promise((resolve) => setTimeout(resolve, 100));

        const closed = await callTool(requestId, "tmux_close", {
            ctxId: refreshedCtxId,
            pane: "continued"
        });
        assert.equal(closed.error, undefined, JSON.stringify(closed));
        assert.equal(closed.result?.structuredContent?.closedPaneId, created.result?.structuredContent?.pane?.id);
    });
});

interface ToolStructuredContent {
    closedPaneId?: string;
    ctxId?: string;
    output?: string[];
    pane?: { id?: string; ownedByCurrentContext?: boolean };
    task?: { id?: string; status?: string };
}

interface ToolSummary {
    inputSchema: {
        anyOf?: JsonValue[];
        oneOf?: JsonValue[];
        properties?: Record<string, { maximum?: number; minimum?: number }>;
        required?: string[];
        type?: string;
    };
    name: string;
}

interface ToolResponse {
    error?: { data?: { code?: string } };
    result?: {
        protocolVersion?: string;
        structuredContent?: ToolStructuredContent;
        tools?: ToolSummary[];
    };
}

interface JsonRpcResponse extends ToolResponse {
    headers: Headers;
}

interface TmuxHarness {
    callTool(requestId: string, name: string, args: Record<string, JsonValue>): Promise<ToolResponse>;
    createContext(): Promise<string>;
    listTools(): Promise<ToolSummary[]>;
}

async function withTmuxHarness(instanceName: string, body: (harness: TmuxHarness) => Promise<void>): Promise<void> {
    const homeDirectory = await createTestTempDirectory("mcp-tmux-home");
    const runtimeDirectory = await mkdtemp(join(
        process.platform === "darwin" ? "/tmp" : tmpdir(),
        "pds-mcp-tmux-",
    ));
    const workspacePath = await createTestTempDirectory("mcp-tmux-workspace");
    const instance = new WorkerInstanceFactory().create({
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
        instances: [{
            auth: { enabled: false, provider: "none" },
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
        const port = requireTcpPort(host.server.address);
        const endpoint = `http://127.0.0.1:${port}/${instanceName}/mcp`;
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
            const response = await callTool("reused-environ-id", "environ_info", { workspace: workspacePath });
            assert.equal(response.error, undefined, JSON.stringify(response));
            return readString(response.result?.structuredContent?.ctxId, "environ_info ctxId");
        };
        const listTools = async () => {
            const response = await postJson(endpoint, {
                id: "list-tools",
                jsonrpc: "2.0",
                method: "tools/list"
            }, headers);
            return response.result?.tools ?? [];
        };

        await body({ callTool, createContext, listTools });
    } finally {
        await host.stop();
        const runtimeInstanceDirectory = join(runtimeDirectory, "devshell-worker", instanceName);
        const sockets = (await readdir(runtimeInstanceDirectory).catch(() => []))
            .filter((name) => name === "tmux.sock" || /^tmux-.+\.sock$/u.test(name));
        for (const socket of sockets) {
            const cleanup = spawnSync("tmux", ["-S", join(runtimeInstanceDirectory, socket), "kill-server"], {
                encoding: "utf8",
            });
            assert.equal(
                cleanup.status,
                0,
                cleanup.stderr || cleanup.error?.message || "failed to stop test tmux server",
            );
        }
        await instance.stop();
        await instance.close();
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
    if (typeof value !== "string") {
        throw new TypeError(`${name} must be a string`);
    }
    return value;
}

async function postJson(url: string, body: JsonValue, extraHeaders?: Record<string, string>): Promise<JsonRpcResponse> {
    const response = await postRawJson(url, body, extraHeaders);
    assert.equal(response.status, 200, response.text);
    return {
        headers: response.headers,
        ...(JSON.parse(response.text) as ToolResponse)
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
