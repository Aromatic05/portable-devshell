import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { requireTcpPort } from "../../../../test/TestHttpSupport.ts";

import { asInstanceName, asWorkspacePath, errorCodes } from "@portable-devshell/shared";
import { WorkerTransportDriverLocal, WorkerBinary, WorkerInstanceFactory } from "@portable-devshell/core/testing";
import { McpHost } from "@portable-devshell/mcp/testing";
import {
    commandAvailable,
    readRelativeMarkerCommand,
    realWorkerTestOptions,
    resolveTestWorkerBinary,
} from "../../../../test/TestPlatformSupport.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { parseMcpHttpResponse } from "../TestMcpHttpResponse.ts";

const fixturesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const workerBinaryPath = resolveTestWorkerBinary();
const tmuxAvailable = process.platform !== "win32" && commandAvailable("tmux", ["-V"]);
type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

test("MCP initialize tools/list and tools/call succeed against the frozen worker", realWorkerTestOptions(workerBinaryPath), async () => {
    const instanceName = "aromatic-pc-mcp-real";
    const homeDirectory = await createTestTempDirectory("mcp-real-home");
    const workspacePath = await createTestTempDirectory("mcp-real-workspace");
    const selectedWorkspacePath = await createTestTempDirectory("mcp-real-selected-workspace");
    const workspaceMarkerName = "mcp-real-selected-workspace-marker.txt";
    const workspaceMarker = "portable-devshell-mcp-real-selected-workspace";
    await writeFile(join(selectedWorkspacePath, workspaceMarkerName), workspaceMarker, "utf8");
    await writeFile(join(selectedWorkspacePath, "legacy-read.txt"), "legacy read\n", "utf8");
    const instance = new WorkerInstanceFactory().create({
        env: { ...process.env, HOME: homeDirectory },
        homeDirectory,
        name: asInstanceName(instanceName),
        transport: new WorkerTransportDriverLocal({
            spawnFunction: nodeSpawn,
            workerBinary: new WorkerBinary(workerBinaryPath!)
        })
    });
    const host = new McpHost({
        instances: [
            {
                auth: { enabled: false, provider: "none" },
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

        const port = requireTcpPort(host.server.address);
        const endpoint = `http://127.0.0.1:${port}/${instanceName}/mcp`;

        const initialize = await postJson(endpoint, await readFixture("mcp-initialize.json"));
        assert.equal(initialize.error, undefined);
        assert.equal(typeof initialize.result?.protocolVersion, "string");
        const sessionHeaders = {
            "mcp-protocol-version": String(initialize.result?.protocolVersion ?? "")
        };
        assert.equal(initialize.headers.get("mcp-session-id"), null);

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
        const tools = list.result?.tools as Array<{ description: string; inputSchema: Record<string, unknown>; name: string }>;
        const bash = tools.find((tool) => tool.name === "bash_run");
        const fileRead = tools.find((tool) => tool.name === "file_read");
        const tmuxManage = tools.find((tool) => tool.name === "tmux_manage");
        assert.notEqual(bash, undefined);
        assert.notEqual(fileRead, undefined);
        assert.notEqual((fileRead?.inputSchema.properties as Record<string, unknown>).files, undefined);
        assert.equal((fileRead?.inputSchema.properties as Record<string, unknown>).path, undefined);
        assert.equal(tmuxManage === undefined, !tmuxAvailable);
        const workerBash = instance.listTools().find((tool) => tool.name === "bash_run");
        const workerBashSchema = workerBash?.inputSchema as Record<string, unknown>;
        const workerTmuxSchema = instance.listTools().find((tool) => tool.name === "tmux_manage")?.inputSchema as Record<string, unknown> | undefined;
        assert.notEqual(bash?.description, workerBash?.description);
        assert.match(bash?.description ?? "", /tmux_run/u);
        assert.equal(workerBash?.description.includes("tmux_run"), false);
        assert.deepEqual(
            Object.fromEntries(Object.entries(bash?.inputSchema ?? {}).filter(([key]) => key !== "properties" && key !== "required")),
            Object.fromEntries(Object.entries(workerBashSchema).filter(([key]) => key !== "properties" && key !== "required"))
        );
        if (tmuxManage !== undefined && workerTmuxSchema !== undefined) {
            assert.deepEqual(
                Object.fromEntries(Object.entries(tmuxManage.inputSchema).filter(([key]) => key !== "properties" && key !== "required")),
                Object.fromEntries(Object.entries(workerTmuxSchema).filter(([key]) => key !== "properties" && key !== "required"))
            );
        }
        assert.deepEqual((bash?.inputSchema.properties as Record<string, unknown>).ctxId, {
            description: "Context ID returned by environ_info in explicit Context mode.",
            minLength: 1,
            type: "string"
        });
        assert.equal((bash?.inputSchema.required as string[]).includes("ctxId"), true);
        if (tmuxManage !== undefined) {
            assert.equal((tmuxManage.inputSchema.required as string[]).includes("ctxId"), true);
        }
        if (tmuxManage !== undefined) {
            const manageProperties = tmuxManage.inputSchema.properties as Record<string, Record<string, unknown>>;
            assert.equal(manageProperties.name?.minLength, 1);
            assert.equal(manageProperties.name?.maxLength, 64);
            assert.equal(manageProperties.name?.pattern, "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
            assert.notEqual(manageProperties.command, undefined);
        }
        for (const name of [
            "file_glob",
            "file_grep",
            ...(tmuxAvailable ? ["tmux_input", "tmux_inspect", "tmux_manage"] : [])
        ]) {
            const schema = tools.find((tool) => tool.name === name)?.inputSchema;
            assert.notEqual(schema, undefined, name);
            assert.equal(schema?.type, "object", name);
            assert.equal(schema?.anyOf, undefined, name);
            assert.equal(schema?.oneOf, undefined, name);
            assert.notEqual(schema?.properties, undefined, name);
            assert.equal((schema?.required as string[]).includes("ctxId"), true, name);
        }
        for (const retired of ["file_find", "file_info", "file_search", "tmux_list", "tmux_create", "tmux_close"]) {
            assert.equal(tools.some((tool) => tool.name === retired), false, retired);
        }

        const ctxId = await createContext(endpoint, sessionHeaders, selectedWorkspacePath);
        const legacyRead = await postJson(endpoint, {
            id: "req-stale-file-read",
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
                arguments: {
                    ctxId,
                    path: "./legacy-read.txt",
                    selector: "1-1:raw",
                    view: "content"
                },
                name: "file_read"
            }
        }, sessionHeaders);
        assert.equal(legacyRead.error, undefined, JSON.stringify(legacyRead));
        assert.equal(legacyRead.result?.isError, false);
        assert.equal(
            (legacyRead.result?.structuredContent as { content?: JsonValue } | undefined)?.content,
            "1:legacy read"
        );
        const legacyGlob = await postJson(endpoint, {
            id: "req-stale-file-find",
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
                arguments: { ctxId, paths: ["./legacy-read.txt"], type: "file" },
                name: "file_find"
            }
        }, sessionHeaders);
        assert.equal(legacyGlob.error, undefined, JSON.stringify(legacyGlob));
        assert.deepEqual(
            (legacyGlob.result?.structuredContent as { entries?: JsonValue } | undefined)?.entries,
            [{ path: "./legacy-read.txt", type: "file" }]
        );
        const legacyGrep = await postJson(endpoint, {
            id: "req-stale-file-search",
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
                arguments: { ctxId, paths: ["./legacy-read.txt"], pattern: "legacy", syntax: "literal" },
                name: "file_search"
            }
        }, sessionHeaders);
        assert.equal(legacyGrep.error, undefined, JSON.stringify(legacyGrep));
        assert.equal(
            ((legacyGrep.result?.structuredContent as { files?: Array<{ content?: string }> } | undefined)?.files?.[0]?.content ?? "").includes("legacy"),
            true
        );
        const legacyInfo = await postJson(endpoint, {
            id: "req-stale-file-info",
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
                arguments: { ctxId, paths: ["./legacy-read.txt"] },
                name: "file_info"
            }
        }, sessionHeaders);
        assert.equal(legacyInfo.error, undefined, JSON.stringify(legacyInfo));
        const legacyInfoEntry = (legacyInfo.result?.structuredContent as { entries?: Array<Record<string, JsonValue>> } | undefined)?.entries?.[0];
        assert.equal(legacyInfoEntry?.exists, undefined);
        assert.equal(legacyInfoEntry?.type, "file");
        assert.equal(legacyInfoEntry?.sizeBytes, undefined);
        if (tmuxAvailable) {
            const legacyTmuxList = await postJson(endpoint, {
                id: "req-stale-tmux-list",
                jsonrpc: "2.0",
                method: "tools/call",
                params: {
                    arguments: { ctxId },
                    name: "tmux_list"
                }
            }, sessionHeaders);
            assert.equal(legacyTmuxList.error, undefined, JSON.stringify(legacyTmuxList));
            assert.equal(
                Array.isArray((legacyTmuxList.result?.structuredContent as { panes?: JsonValue } | undefined)?.panes),
                true
            );
        }
        const callRequest = withToolContext(
            await readFixture("mcp-tools-call.json"),
            ctxId
        ) as { params: { arguments: Record<string, JsonValue> } };
        callRequest.params.arguments.command = readRelativeMarkerCommand(workspaceMarkerName);
        const call = await postJson(endpoint, callRequest as JsonValue, sessionHeaders);
        assert.equal(call.error, undefined);
        assert.equal(call.result?.isError, false);
        assert.match(
            String((call.result?.structuredContent as { stdout?: JsonValue } | undefined)?.stdout ?? ""),
            new RegExp(workspaceMarker, "u")
        );

        const toolCalls = await instance.readToolCalls();
        assert.equal(toolCalls.some((record) => record.toolName === "bash_run" && record.status === "completed"), true);
        assert.equal(toolCalls.some((record) => record.source === "mcp"), true);
        const auditDatabase = await stat(join(homeDirectory, ".devshell", instanceName, "control-worker", "audit.sqlite3"));
        assert.equal(auditDatabase.size > 0, true);

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        assert.equal(replay.events.some((event) => event.type === "mcp.toolCalled"), true);
    } finally {
        await host.stop();
        await instance.stop();
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
        await rm(workspacePath, { force: true, recursive: true });
        await rm(selectedWorkspacePath, { force: true, recursive: true });
    }
});

test("MCP tools/call waits for approval before invoking the worker tool", realWorkerTestOptions(workerBinaryPath), async () => {
    const instanceName = "aromatic-pc-mcp-approval";
    const homeDirectory = await createTestTempDirectory("mcp-approval-home");
    const workspacePath = await createTestTempDirectory("mcp-approval-workspace");
    const instance = new WorkerInstanceFactory().create({
        approvalPolicy: { mode: "ask" },
        env: { ...process.env, HOME: homeDirectory },
        homeDirectory,
        name: asInstanceName(instanceName),
        transport: new WorkerTransportDriverLocal({
            spawnFunction: nodeSpawn,
            workerBinary: new WorkerBinary(workerBinaryPath!)
        })
    });
    const host = new McpHost({
        instances: [
            {
                auth: { enabled: false, provider: "none" },
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

        const port = requireTcpPort(host.server.address);
        const endpoint = `http://127.0.0.1:${port}/${instanceName}/mcp`;

        const initialize = await postJson(endpoint, await readFixture("mcp-initialize.json"));
        const sessionHeaders = {
            "mcp-protocol-version": String(initialize.result?.protocolVersion ?? "")
        };

        await postRawJson(
            endpoint,
            {
                jsonrpc: "2.0",
                method: "notifications/initialized"
            },
            sessionHeaders
        );

        const ctxId = await createContext(endpoint, sessionHeaders, workspacePath);
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
        await host.stop();
        await instance.stop();
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
        await rm(workspacePath, { force: true, recursive: true });
    }
});

async function createContext(endpoint: string, headers: Record<string, string>, workspace: string): Promise<string> {
    const response = await postJson(endpoint, {
        id: `req-environ-${Date.now()}`,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { workspace }, name: "environ_info" }
    }, headers);
    const ctxId = response.result?.structuredContent?.ctxId;
    const memoryDirectory = response.result?.structuredContent?.projectMemoryDirectory;
    const memoryAgentFile = response.result?.structuredContent?.projectMemoryAgentFile;
    const temporaryDirectory = response.result?.structuredContent?.temporaryDirectory;
    assert.equal(typeof ctxId, "string");
    assert.equal(memoryDirectory, undefined);
    assert.equal(memoryAgentFile, undefined);
    assert.equal(typeof temporaryDirectory, "string");
    assert.equal((await stat(temporaryDirectory)).isDirectory(), true);
    return ctxId;
}

function withToolContext(body: JsonValue, ctxId: string): JsonValue {
    const request = structuredClone(body) as {
        params?: { arguments?: Record<string, JsonValue> };
    };
    request.params ??= {};
    request.params.arguments = { ...(request.params.arguments ?? {}), ctxId, timeoutMs: 30_000 };
    return request as JsonValue;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function postJson(url: string, body: JsonValue, extraHeaders?: Record<string, string>): Promise<any> {
    const response = await postRawJson(url, body, extraHeaders);

    assert.equal(response.status, 200);
    return {
        headers: response.headers,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(parseMcpHttpResponse<Record<string, any>>(response.text))
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
