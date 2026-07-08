import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { asInstanceName, asWorkspacePath } from "@portable-devshell/shared";
import { LocalWorkerTransport, WorkerBinary, WorkerInstanceFactory } from "@portable-devshell/core";
import { McpHost } from "@portable-devshell/mcp";

const fixturesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

test("MCP initialize tools/list and tools/call succeed against the frozen worker", async (t) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-mcp-real-home-"));
    const workspacePath = await mkdtemp(join(tmpdir(), "portable-devshell-mcp-real-workspace-"));
    const workerBinaryPath = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "target/debug/devshell-worker");
    const instance = new WorkerInstanceFactory().create({
        allowTools: ["bash_run"],
        defaultWorkspace: asWorkspacePath(workspacePath),
        env: { ...process.env, HOME: homeDirectory },
        homeDirectory,
        name: asInstanceName("aromatic-pc"),
        transport: new LocalWorkerTransport({
            spawnFunction: nodeSpawn,
            workerBinary: new WorkerBinary(workerBinaryPath)
        })
    });
    const host = new McpHost({
        auth: {
            enabled: false,
            provider: "none"
        },
        instances: [
            {
                allowlist: ["bash_run"],
                name: "aromatic-pc",
                worker: instance
            }
        ],
        listenHost: "127.0.0.1",
        listenPort: 0
    });

    t.after(async () => {
        await host.stop().catch(() => undefined);
        instance.close();
        await instance.stop().catch(() => undefined);
        await rm(homeDirectory, { force: true, recursive: true });
        await rm(workspacePath, { force: true, recursive: true });
    });

    await instance.start();
    await host.start();

    const address = host.server.address;
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const endpoint = `http://127.0.0.1:${address.port}/aromatic-pc/mcp`;

    const initialize = await postJson(endpoint, await readFixture("mcp-initialize.json"));
    assert.equal(initialize.error, undefined);
    assert.equal(typeof initialize.result?.sessionId, "string");

    const list = await postJson(endpoint, {
        id: "req-tools-list",
        jsonrpc: "2.0",
        method: "tools/list"
    });
    assert.equal(list.error, undefined);
    assert.deepEqual(list.result?.tools.map((tool: { name: string }) => tool.name), ["bash_run"]);
    assert.deepEqual(list.result?.tools[0]?.inputSchema, instance.listTools()[0]?.inputSchema);

    const call = await postJson(endpoint, await readFixture("mcp-tools-call.json"));
    assert.equal(call.error, undefined);
    assert.equal(call.result?.isError, false);
    assert.match(String(call.result?.content?.[0]?.text ?? ""), new RegExp(workspacePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

    const toolCalls = await instance.readToolCalls();
    assert.equal(toolCalls.some((record) => record.toolName === "bash_run" && record.status === "completed"), true);
    assert.match(await readFile(join(homeDirectory, ".devshell", "aromatic-pc", "control-worker", "tool-calls.jsonl"), "utf8"), /bash_run/u);
});

async function postJson(url: string, body: JsonValue): Promise<any> {
    const response = await fetch(url, {
        body: JSON.stringify(body),
        headers: {
            "content-type": "application/json"
        },
        method: "POST"
    });

    assert.equal(response.status, 200);
    return await response.json();
}

async function readFixture(name: string): Promise<JsonValue> {
    return JSON.parse(await readFile(resolve(fixturesDirectory, name), "utf8")) as JsonValue;
}
