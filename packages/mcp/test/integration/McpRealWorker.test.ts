import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { asInstanceName, asWorkspacePath, errorCodes } from "@portable-devshell/shared";
import { LocalWorkerTransport, WorkerBinary, WorkerInstanceFactory } from "@portable-devshell/core";
import { McpHost } from "@portable-devshell/mcp";

const fixturesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

test("MCP initialize tools/list and tools/call succeed against the frozen worker", async () => {
    const instanceName = "aromatic-pc-mcp-real";
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-mcp-real-home-"));
    const workspacePath = await mkdtemp(join(tmpdir(), "portable-devshell-mcp-real-workspace-"));
    const workerBinaryPath = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "target/debug/devshell-worker");
    const instance = new WorkerInstanceFactory().create({
        defaultWorkspace: asWorkspacePath(workspacePath),
        env: { ...process.env, HOME: homeDirectory },
        homeDirectory,
        name: asInstanceName(instanceName),
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
                policy: { capabilities: ["execute"], groups: ["bash", "tmux"] },
                name: instanceName,
                worker: instance
            }
        ],
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

        const initialize = await postJson(endpoint, await readFixture("mcp-initialize.json"));
        assert.equal(initialize.error, undefined);
        assert.equal(typeof initialize.result?.protocolVersion, "string");
        const sessionHeaders = {
            "mcp-protocol-version": String(initialize.result?.protocolVersion ?? ""),
            "mcp-session-id": String(initialize.headers.get("mcp-session-id") ?? "")
        };
        assert.notEqual(sessionHeaders["mcp-session-id"], "");

        const initialized = await postRawJson(endpoint, {
            jsonrpc: "2.0",
            method: "notifications/initialized"
        }, sessionHeaders);
        assert.equal(initialized.status, 202);

        const list = await postJson(endpoint, {
            id: "req-tools-list",
            jsonrpc: "2.0",
            method: "tools/list"
        }, sessionHeaders);
        assert.equal(list.error, undefined);
        const tools = list.result?.tools as Array<{ inputSchema: Record<string, unknown>; name: string }>;
        const bash = tools.find((tool) => tool.name === "bash_run");
        const tmuxCreate = tools.find((tool) => tool.name === "tmux_create");
        assert.notEqual(bash, undefined);
        assert.notEqual(tmuxCreate, undefined);
        const workerBashSchema = instance.listTools().find((tool) => tool.name === "bash_run")?.inputSchema as Record<string, unknown>;
        const workerTmuxSchema = instance.listTools().find((tool) => tool.name === "tmux_create")?.inputSchema as Record<string, unknown>;
        assert.deepEqual(
            Object.fromEntries(Object.entries(bash?.inputSchema ?? {}).filter(([key]) => key !== "properties" && key !== "required")),
            Object.fromEntries(Object.entries(workerBashSchema).filter(([key]) => key !== "properties" && key !== "required"))
        );
        assert.deepEqual(
            Object.fromEntries(Object.entries(tmuxCreate?.inputSchema ?? {}).filter(([key]) => key !== "properties" && key !== "required")),
            Object.fromEntries(Object.entries(workerTmuxSchema).filter(([key]) => key !== "properties" && key !== "required"))
        );
        assert.deepEqual((bash?.inputSchema.properties as Record<string, unknown>).ctxId, {
            description: "Invocation context returned by environ_info.",
            minLength: 1,
            type: "string"
        });
        assert.equal((bash?.inputSchema.required as string[]).includes("ctxId"), true);
        assert.equal((tmuxCreate?.inputSchema.required as string[]).includes("ctxId"), true);
        assert.deepEqual(
            (tmuxCreate?.inputSchema.properties as Record<string, unknown>).name,
            {
                maxLength: 64,
                minLength: 1,
                pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
                type: "string"
            }
        );

        const ctxId = await createContext(endpoint, sessionHeaders);
        const call = await postJson(
            endpoint,
            withToolContext(await readFixture("mcp-tools-call.json"), ctxId),
            sessionHeaders
        );
        assert.equal(call.error, undefined);
        assert.equal(call.result?.isError, false);
        assert.match(String(call.result?.content?.[0]?.text ?? ""), new RegExp(workspacePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

        const toolCalls = await instance.readToolCalls();
        assert.equal(toolCalls.some((record) => record.toolName === "bash_run" && record.status === "completed"), true);
        assert.equal(toolCalls.some((record) => record.source === "mcp"), true);
        assert.match(await readFile(join(homeDirectory, ".devshell", instanceName, "control-worker", "tool-calls.jsonl"), "utf8"), /bash_run/u);

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        assert.equal(replay.events.some((event) => event.type === "mcp.sessionOpened"), true);
        assert.equal(replay.events.some((event) => event.type === "mcp.toolCalled"), true);
    } finally {
        await host.stop().catch(() => undefined);
        await instance.stop().catch(() => undefined);
        await instance.close().catch(() => undefined);
        await rm(homeDirectory, { force: true, recursive: true });
        await rm(workspacePath, { force: true, recursive: true });
    }
});

test("MCP tools/call waits for approval before invoking the worker tool", async () => {
    const instanceName = "aromatic-pc-mcp-approval";
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-mcp-approval-home-"));
    const workspacePath = await mkdtemp(join(tmpdir(), "portable-devshell-mcp-approval-workspace-"));
    const workerBinaryPath = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "target/debug/devshell-worker");
    const instance = new WorkerInstanceFactory().create({
        approvalPolicy: { mode: "ask" },
        defaultWorkspace: asWorkspacePath(workspacePath),
        env: { ...process.env, HOME: homeDirectory },
        homeDirectory,
        name: asInstanceName(instanceName),
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
                policy: { capabilities: ["execute"], groups: ["bash"] },
                name: instanceName,
                worker: instance
            }
        ],
        listenHost: "127.0.0.1",
        listenPort: 0
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let callPromise: Promise<any> | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let deniedPromise: Promise<any> | undefined;

    try {
        await instance.start();
        await host.start();

        const address = host.server.address;
        assert.notEqual(address, null);
        assert.equal(typeof address, "object");
        const endpoint = `http://127.0.0.1:${address.port}/${instanceName}/mcp`;

        const initialize = await postJson(endpoint, await readFixture("mcp-initialize.json"));
        const sessionHeaders = {
            "mcp-protocol-version": String(initialize.result?.protocolVersion ?? ""),
            "mcp-session-id": String(initialize.headers.get("mcp-session-id") ?? "")
        };

        await postRawJson(
            endpoint,
            {
                jsonrpc: "2.0",
                method: "notifications/initialized"
            },
            sessionHeaders
        );

        const ctxId = await createContext(endpoint, sessionHeaders);
        callPromise = postJson(
            endpoint,
            withToolContext(await readFixture("mcp-tools-call.json"), ctxId),
            sessionHeaders
        );

        const pendingApproval = await waitForPendingApproval(instance);
        assert.equal(pendingApproval.status, "pending");
        assert.equal(pendingApproval.source, "mcp");
        assert.equal(
            (await instance.readToolCalls()).some((record) => record.source === "mcp" && record.status === "pendingApproval"),
            true
        );

        await instance.decideApproval(pendingApproval.approvalId, {
            decidedBy: "cli",
            decision: "approve",
            reason: "approved in mcp test"
        });

        const call = await callPromise;
        callPromise = undefined;
        assert.equal(call.error, undefined);
        assert.equal(call.result?.isError, false);

        const toolCalls = await instance.readToolCalls();
        const approvedToolCall = toolCalls.find((record) => record.toolName === "bash_run");
        assert.equal(approvedToolCall?.source, "mcp");
        assert.equal(approvedToolCall?.decision, "approved");
        assert.equal(approvedToolCall?.status, "completed");

        deniedPromise = postJson(
            endpoint,
            withToolContext(await readFixture("mcp-tools-call.json"), ctxId),
            sessionHeaders
        );

        const deniedApproval = await waitForPendingApproval(instance);
        await instance.decideApproval(deniedApproval.approvalId, {
            decidedBy: "cli",
            decision: "deny",
            reason: "denied in mcp test"
        });

        const denied = await deniedPromise;
        deniedPromise = undefined;
        assert.equal(denied.error?.data?.code, errorCodes.coreApprovalDenied);

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        assert.equal(replay.events.some((event) => event.type === "approval.requested"), true);
        assert.equal(replay.events.some((event) => event.type === "approval.approved"), true);
        assert.equal(replay.events.some((event) => event.type === "approval.denied"), true);
        assert.equal(replay.events.some((event) => event.type === "mcp.toolCalled"), true);

        const records = await instance.readToolCalls();
        assert.equal(records.some((record) => record.source === "mcp" && record.status === "denied"), true);
    } finally {
        await denyPendingApprovals(instance).catch(() => undefined);
        await callPromise?.catch(() => undefined);
        await deniedPromise?.catch(() => undefined);
        await host.stop().catch(() => undefined);
        await instance.stop().catch(() => undefined);
        await instance.close().catch(() => undefined);
        await rm(homeDirectory, { force: true, recursive: true });
        await rm(workspacePath, { force: true, recursive: true });
    }
});

async function createContext(endpoint: string, headers: Record<string, string>): Promise<string> {
    const response = await postJson(endpoint, {
        id: `req-environ-${Date.now()}`,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: {}, name: "environ_info" }
    }, headers);
    const ctxId = response.result?.structuredContent?.ctxId;
    assert.equal(typeof ctxId, "string");
    return ctxId;
}

function withToolContext(body: JsonValue, ctxId: string): JsonValue {
    const request = structuredClone(body) as {
        params?: { arguments?: Record<string, JsonValue> };
    };
    request.params ??= {};
    request.params.arguments = { ...(request.params.arguments ?? {}), ctxId };
    return request as JsonValue;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function postJson(url: string, body: JsonValue, extraHeaders?: Record<string, string>): Promise<any> {
    const response = await postRawJson(url, body, extraHeaders);

    assert.equal(response.status, 200);
    return {
        headers: response.headers,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(JSON.parse(response.text) as Record<string, any>)
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

async function readFixture(name: string): Promise<JsonValue> {
    return JSON.parse(await readFile(resolve(fixturesDirectory, name), "utf8")) as JsonValue;
}

async function waitForPendingApproval(instance: {
    listApprovals(): Promise<Array<{ approvalId: string; source: string; status: string }>>;
}): Promise<{ approvalId: string; source: string; status: string }> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const pending = (await instance.listApprovals()).find((approval) => approval.status === "pending");

        if (pending !== undefined) {
            return pending;
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error("Timed out waiting for a pending approval.");
}

async function denyPendingApprovals(instance: {
    decideApproval(
        approvalId: string,
        input: { decidedBy: "cli"; decision: "deny"; reason: string }
    ): Promise<unknown>;
    listApprovals(): Promise<Array<{ approvalId: string; status: string }>>;
}): Promise<void> {
    const pendingApprovals = (await instance.listApprovals()).filter((approval) => approval.status === "pending");

    for (const approval of pendingApprovals) {
        await instance.decideApproval(approval.approvalId, {
            decidedBy: "cli",
            decision: "deny",
            reason: "cleanup pending MCP approval"
        });
    }
}
