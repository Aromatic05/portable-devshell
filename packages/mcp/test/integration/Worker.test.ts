import assert from "node:assert/strict";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import {
    readFile,
    rm,
    stat,
    writeFile,
    mkdtemp,
    readdir,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { requireTcpPort } from "../../../../test/TestHttpSupport.ts";
import {
    asInstanceName,
    errorCodes,
    type ToolCallRecord,
} from "@portable-devshell/shared";
import {
    WorkerTransportDriverLocal,
    WorkerBinary,
    WorkerInstanceFactory,
} from "@portable-devshell/core/testing";
import { ToolCallBoundarySequence } from "../../../core/src/toolcall/boundary/Sequence.ts";
import { McpHost } from "@portable-devshell/mcp/testing";
import {
    commandAvailable,
    readRelativeMarkerCommand,
    realWorkerTestOptions,
    resolveTestWorkerBinary,
    tmuxTestOptions,
} from "../../../../test/TestPlatformSupport.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { parseMcpHttpResponse } from "../TestMcpHttpResponse.ts";
import { tmpdir } from "node:os";

{
    const fixturesDirectory = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../fixtures",
    );
    const workerBinaryPath = resolveTestWorkerBinary();
    const tmuxAvailable =
        process.platform !== "win32" && commandAvailable("tmux", ["-V"]);
    type JsonValue =
        | boolean
        | number
        | null
        | string
        | JsonValue[]
        | { [key: string]: JsonValue };

    interface JsonRpcResponse {
        error?: JsonValue;
        headers: Headers;
        result?: {
            isError?: boolean;
            protocolVersion?: string;
            structuredContent?: Record<string, JsonValue>;
            tools?: JsonValue[];
        };
    }

    test(
        "MCP initialize tools/list and tools/call succeed against the frozen worker",
        realWorkerTestOptions(workerBinaryPath),
        async () => {
            const instanceName = "aromatic-pc-mcp-real";
            const homeDirectory =
                await createTestTempDirectory("mcp-real-home");
            const workspacePath =
                await createTestTempDirectory("mcp-real-workspace");
            const selectedWorkspacePath = await createTestTempDirectory(
                "mcp-real-selected-workspace",
            );
            const workspaceMarkerName =
                "mcp-real-selected-workspace-marker.txt";
            const workspaceMarker =
                "portable-devshell-mcp-real-selected-workspace";
            await writeFile(
                join(selectedWorkspacePath, workspaceMarkerName),
                workspaceMarker,
                "utf8",
            );
            await writeFile(
                join(selectedWorkspacePath, "legacy-read.txt"),
                "legacy read\n",
                "utf8",
            );
            const instance = new WorkerInstanceFactory().create({
                env: { ...process.env, HOME: homeDirectory },
                homeDirectory,
                name: asInstanceName(instanceName),
                transport: new WorkerTransportDriverLocal({
                    spawnFunction: nodeSpawn,
                    workerBinary: new WorkerBinary(workerBinaryPath!),
                }),
            });
            const host = new McpHost({
                instances: [
                    {
                        auth: { enabled: false, provider: "none" },
                        name: instanceName,
                        worker: instance,
                    },
                ],
                listenHost: "127.0.0.1",
                listenPort: 0,
            });

            try {
                await instance.start();
                await host.start();

                const port = requireTcpPort(host.server.address);
                const endpoint = `http://127.0.0.1:${port}/${instanceName}/mcp`;

                const initialize = await postJson(
                    endpoint,
                    await readFixture("mcp-initialize.json"),
                );
                assert.equal(initialize.error, undefined);
                assert.equal(
                    typeof initialize.result?.protocolVersion,
                    "string",
                );
                const sessionHeaders = {
                    "mcp-protocol-version": String(
                        initialize.result?.protocolVersion ?? "",
                    ),
                };
                assert.equal(initialize.headers.get("mcp-session-id"), null);

                const initialized = await postRawJson(
                    endpoint,
                    {
                        jsonrpc: "2.0",
                        method: "notifications/initialized",
                    },
                    sessionHeaders,
                );
                assert.equal(initialized.status, 202);

                const list = await postJson(
                    endpoint,
                    {
                        id: "req-tools-list",
                        jsonrpc: "2.0",
                        method: "tools/list",
                    },
                    sessionHeaders,
                );
                assert.equal(list.error, undefined);
                const tools = list.result?.tools as Array<{
                    description: string;
                    inputSchema: Record<string, unknown>;
                    name: string;
                }>;
                const bash = tools.find((tool) => tool.name === "bash_run");
                const fileRead = tools.find(
                    (tool) => tool.name === "file_read",
                );
                const tmuxManage = tools.find(
                    (tool) => tool.name === "tmux_manage",
                );
                assert.notEqual(bash, undefined);
                assert.notEqual(fileRead, undefined);
                assert.notEqual(
                    (
                        fileRead?.inputSchema.properties as Record<
                            string,
                            unknown
                        >
                    ).files,
                    undefined,
                );
                assert.equal(
                    (
                        fileRead?.inputSchema.properties as Record<
                            string,
                            unknown
                        >
                    ).path,
                    undefined,
                );
                assert.equal(tmuxManage === undefined, !tmuxAvailable);
                const workerBash = instance
                    .listTools()
                    .find((tool) => tool.name === "bash_run");
                const workerBashSchema = workerBash?.inputSchema as Record<
                    string,
                    unknown
                >;
                const workerTmuxSchema = instance
                    .listTools()
                    .find((tool) => tool.name === "tmux_manage")
                    ?.inputSchema as Record<string, unknown> | undefined;
                assert.notEqual(bash?.description, workerBash?.description);
                assert.match(bash?.description ?? "", /tmux_run/u);
                assert.equal(
                    workerBash?.description.includes("tmux_run"),
                    false,
                );
                assert.deepEqual(
                    Object.fromEntries(
                        Object.entries(bash?.inputSchema ?? {}).filter(
                            ([key]) =>
                                ![
                                    "$schema",
                                    "properties",
                                    "required",
                                    "title",
                                ].includes(key),
                        ),
                    ),
                    Object.fromEntries(
                        Object.entries(workerBashSchema).filter(
                            ([key]) =>
                                ![
                                    "$schema",
                                    "properties",
                                    "required",
                                    "title",
                                ].includes(key),
                        ),
                    ),
                );
                if (
                    tmuxManage !== undefined &&
                    workerTmuxSchema !== undefined
                ) {
                    assert.deepEqual(
                        Object.fromEntries(
                            Object.entries(tmuxManage.inputSchema).filter(
                                ([key]) =>
                                    ![
                                        "$schema",
                                        "properties",
                                        "required",
                                        "title",
                                    ].includes(key),
                            ),
                        ),
                        Object.fromEntries(
                            Object.entries(workerTmuxSchema).filter(
                                ([key]) =>
                                    ![
                                        "$schema",
                                        "properties",
                                        "required",
                                        "title",
                                    ].includes(key),
                            ),
                        ),
                    );
                }
                assert.deepEqual(
                    (bash?.inputSchema.properties as Record<string, unknown>)
                        .ctxId,
                    {
                        description: "Context from environ_info.",
                        minLength: 1,
                        type: "string",
                    },
                );
                assert.equal(
                    (bash?.inputSchema.required as string[]).includes("ctxId"),
                    true,
                );
                if (tmuxManage !== undefined) {
                    assert.equal(
                        (tmuxManage.inputSchema.required as string[]).includes(
                            "ctxId",
                        ),
                        true,
                    );
                }
                if (tmuxManage !== undefined) {
                    const manageProperties = tmuxManage.inputSchema
                        .properties as Record<string, Record<string, unknown>>;
                    assert.equal(manageProperties.name?.minLength, 1);
                    assert.equal(manageProperties.name?.maxLength, 64);
                    assert.equal(
                        manageProperties.name?.pattern,
                        "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
                    );
                    assert.notEqual(manageProperties.command, undefined);
                }
                for (const name of [
                    "file_glob",
                    "file_grep",
                    ...(tmuxAvailable
                        ? ["tmux_input", "tmux_inspect", "tmux_manage"]
                        : []),
                ]) {
                    const schema = tools.find(
                        (tool) => tool.name === name,
                    )?.inputSchema;
                    assert.notEqual(schema, undefined, name);
                    assert.equal(schema?.type, "object", name);
                    assert.equal(schema?.anyOf, undefined, name);
                    assert.equal(schema?.oneOf, undefined, name);
                    assert.notEqual(schema?.properties, undefined, name);
                    assert.equal(
                        (schema?.required as string[]).includes("ctxId"),
                        true,
                        name,
                    );
                }
                for (const retired of [
                    "file_find",
                    "file_info",
                    "file_search",
                    "tmux_list",
                    "tmux_create",
                    "tmux_close",
                ]) {
                    assert.equal(
                        tools.some((tool) => tool.name === retired),
                        false,
                        retired,
                    );
                }

                const ctxId = await createContext(
                    endpoint,
                    sessionHeaders,
                    selectedWorkspacePath,
                );
                const legacyRead = await postJson(
                    endpoint,
                    {
                        id: "req-stale-file-read",
                        jsonrpc: "2.0",
                        method: "tools/call",
                        params: {
                            arguments: {
                                ctxId,
                                path: "./legacy-read.txt",
                                selector: "1-1:raw",
                                view: "content",
                            },
                            name: "file_read",
                        },
                    },
                    sessionHeaders,
                );
                assert.equal(
                    legacyRead.error,
                    undefined,
                    JSON.stringify(legacyRead),
                );
                assert.equal(legacyRead.result?.isError, false);
                assert.equal(
                    (
                        legacyRead.result?.structuredContent as
                            { content?: JsonValue } | undefined
                    )?.content,
                    "1:legacy read",
                );
                const legacyGlob = await postJson(
                    endpoint,
                    {
                        id: "req-stale-file-find",
                        jsonrpc: "2.0",
                        method: "tools/call",
                        params: {
                            arguments: {
                                ctxId,
                                paths: ["./legacy-read.txt"],
                                type: "file",
                            },
                            name: "file_find",
                        },
                    },
                    sessionHeaders,
                );
                assert.equal(
                    legacyGlob.error,
                    undefined,
                    JSON.stringify(legacyGlob),
                );
                assert.deepEqual(
                    (
                        legacyGlob.result?.structuredContent as
                            { entries?: JsonValue } | undefined
                    )?.entries,
                    [{ path: "./legacy-read.txt", type: "file" }],
                );
                const legacyGrep = await postJson(
                    endpoint,
                    {
                        id: "req-stale-file-search",
                        jsonrpc: "2.0",
                        method: "tools/call",
                        params: {
                            arguments: {
                                ctxId,
                                paths: ["./legacy-read.txt"],
                                pattern: "legacy",
                                syntax: "literal",
                            },
                            name: "file_search",
                        },
                    },
                    sessionHeaders,
                );
                assert.equal(
                    legacyGrep.error,
                    undefined,
                    JSON.stringify(legacyGrep),
                );
                assert.equal(
                    (
                        (
                            legacyGrep.result?.structuredContent as
                                | { files?: Array<{ content?: string }> }
                                | undefined
                        )?.files?.[0]?.content ?? ""
                    ).includes("legacy"),
                    true,
                );
                const legacyInfo = await postJson(
                    endpoint,
                    {
                        id: "req-stale-file-info",
                        jsonrpc: "2.0",
                        method: "tools/call",
                        params: {
                            arguments: { ctxId, paths: ["./legacy-read.txt"] },
                            name: "file_info",
                        },
                    },
                    sessionHeaders,
                );
                assert.equal(
                    legacyInfo.error,
                    undefined,
                    JSON.stringify(legacyInfo),
                );
                const legacyInfoEntry = (
                    legacyInfo.result?.structuredContent as
                        | { entries?: Array<Record<string, JsonValue>> }
                        | undefined
                )?.entries?.[0];
                assert.equal(legacyInfoEntry?.exists, undefined);
                assert.equal(legacyInfoEntry?.type, "file");
                assert.equal(legacyInfoEntry?.sizeBytes, undefined);
                if (tmuxAvailable) {
                    const legacyTmuxList = await postJson(
                        endpoint,
                        {
                            id: "req-stale-tmux-list",
                            jsonrpc: "2.0",
                            method: "tools/call",
                            params: {
                                arguments: { ctxId },
                                name: "tmux_list",
                            },
                        },
                        sessionHeaders,
                    );
                    assert.equal(
                        legacyTmuxList.error,
                        undefined,
                        JSON.stringify(legacyTmuxList),
                    );
                    assert.equal(
                        Array.isArray(
                            (
                                legacyTmuxList.result?.structuredContent as
                                    { panes?: JsonValue } | undefined
                            )?.panes,
                        ),
                        true,
                    );
                }
                const callRequest = withToolContext(
                    await readFixture("mcp-tools-call.json"),
                    ctxId,
                ) as { params: { arguments: Record<string, JsonValue> } };
                callRequest.params.arguments.command =
                    readRelativeMarkerCommand(workspaceMarkerName);
                const call = await postJson(
                    endpoint,
                    callRequest as JsonValue,
                    sessionHeaders,
                );
                assert.equal(call.error, undefined);
                assert.equal(call.result?.isError, false);
                assert.match(
                    String(
                        (
                            call.result?.structuredContent as
                                { stdout?: JsonValue } | undefined
                        )?.stdout ?? "",
                    ),
                    new RegExp(workspaceMarker, "u"),
                );

                const toolCalls = await instance.readToolCalls();
                assert.equal(
                    toolCalls.some(
                        (record) =>
                            record.toolName === "bash_run" &&
                            record.status === "completed",
                    ),
                    true,
                );
                assert.equal(
                    toolCalls.some((record) => record.source === "mcp"),
                    true,
                );
                const auditDatabase = await stat(
                    join(
                        homeDirectory,
                        ".devshell",
                        instanceName,
                        "control-worker",
                        "audit.sqlite3",
                    ),
                );
                assert.equal(auditDatabase.size > 0, true);

                const replay = instance.subscribe(1);
                assert.equal(replay.kind, "events");
                assert.equal(
                    replay.events.some(
                        (event) => event.type === "mcp.toolCalled",
                    ),
                    true,
                );
            } finally {
                await host.stop();
                await instance.stop();
                await instance.close();
                await rm(homeDirectory, { force: true, recursive: true });
                await rm(workspacePath, { force: true, recursive: true });
                await rm(selectedWorkspacePath, {
                    force: true,
                    recursive: true,
                });
            }
        },
    );

    test(
        "MCP review-rejected ToolCalls remain visible in Audit",
        realWorkerTestOptions(workerBinaryPath),
        async () => {
            const instanceName = "aromatic-pc-mcp-review-reject";
            const homeDirectory = await createTestTempDirectory(
                "mcp-review-reject-home",
            );
            const workspacePath = await createTestTempDirectory(
                "mcp-review-reject-workspace",
            );
            const instance = new WorkerInstanceFactory().create({
                env: { ...process.env, HOME: homeDirectory },
                homeDirectory,
                name: asInstanceName(instanceName),
                transport: new WorkerTransportDriverLocal({
                    spawnFunction: nodeSpawn,
                    workerBinary: new WorkerBinary(workerBinaryPath!),
                }),
            });
            instance.bindToolCallBoundary(async () => ({
                release() {},
                sequence: new ToolCallBoundarySequence({
                    reviews: [
                        async (input) =>
                            input.direction === "inbound" &&
                            input.kind === "call" &&
                            input.toolName === "bash_run"
                                ? {
                                      decision: "reject" as const,
                                      reason: "blocked by review",
                                  }
                                : { decision: "accept" as const },
                    ],
                }),
            }));
            const host = new McpHost({
                instances: [
                    {
                        auth: { enabled: false, provider: "none" },
                        name: instanceName,
                        worker: instance,
                    },
                ],
                listenHost: "127.0.0.1",
                listenPort: 0,
            });

            try {
                await instance.start();
                await host.start();

                const port = requireTcpPort(host.server.address);
                const endpoint =
                    "http://127.0.0.1:" + port + "/" + instanceName + "/mcp";
                const initialize = await postJson(
                    endpoint,
                    await readFixture("mcp-initialize.json"),
                );
                const sessionHeaders = {
                    "mcp-protocol-version": String(
                        initialize.result?.protocolVersion ?? "",
                    ),
                };
                await postRawJson(
                    endpoint,
                    {
                        jsonrpc: "2.0",
                        method: "notifications/initialized",
                    },
                    sessionHeaders,
                );

                const ctxId = await createContext(
                    endpoint,
                    sessionHeaders,
                    workspacePath,
                );
                const rejected = await postJson(
                    endpoint,
                    withToolContext(
                        await readFixture("mcp-tools-call.json"),
                        ctxId,
                    ),
                    sessionHeaders,
                );
                assert.equal(
                    rejected.error?.data?.code,
                    errorCodes.coreToolCallRejected,
                );

                const records = await instance.readToolCalls({ ctxId });
                const denied = records.find(
                    (record) =>
                        record.toolName === "bash_run" &&
                        record.status === "denied",
                );
                assert.ok(denied, JSON.stringify(records));
                assert.equal(denied.error, errorCodes.coreToolCallRejected);
                assert.equal(denied.source, "mcp");

                const replay = instance.subscribe(1);
                assert.equal(replay.kind, "events");
                assert.equal(
                    replay.events.some(
                        (event) =>
                            event.type === "toolCall.denied" &&
                            event.data !== undefined &&
                            typeof event.data === "object" &&
                            !Array.isArray(event.data) &&
                            event.data.callId === denied.callId,
                    ),
                    true,
                );
            } finally {
                await host.stop();
                await instance.stop();
                await instance.close();
                await rm(homeDirectory, { force: true, recursive: true });
                await rm(workspacePath, { force: true, recursive: true });
            }
        },
    );

    test(
        "MCP control and worker tool calls share the approval boundary",
        realWorkerTestOptions(workerBinaryPath),
        async () => {
            const instanceName = "aromatic-pc-mcp-approval";
            const homeDirectory =
                await createTestTempDirectory("mcp-approval-home");
            const workspacePath = await createTestTempDirectory(
                "mcp-approval-workspace",
            );
            const instance = new WorkerInstanceFactory().create({
                approvalPolicy: { mode: "ask" },
                env: { ...process.env, HOME: homeDirectory },
                homeDirectory,
                name: asInstanceName(instanceName),
                transport: new WorkerTransportDriverLocal({
                    spawnFunction: nodeSpawn,
                    workerBinary: new WorkerBinary(workerBinaryPath!),
                }),
            });
            const host = new McpHost({
                instances: [
                    {
                        auth: { enabled: false, provider: "none" },
                        name: instanceName,
                        worker: instance,
                    },
                ],
                listenHost: "127.0.0.1",
                listenPort: 0,
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

                const initialize = await postJson(
                    endpoint,
                    await readFixture("mcp-initialize.json"),
                );
                const sessionHeaders = {
                    "mcp-protocol-version": String(
                        initialize.result?.protocolVersion ?? "",
                    ),
                };

                await postRawJson(
                    endpoint,
                    {
                        jsonrpc: "2.0",
                        method: "notifications/initialized",
                    },
                    sessionHeaders,
                );

                const contextPromise = createContext(
                    endpoint,
                    sessionHeaders,
                    workspacePath,
                );
                const contextApproval = await waitForPendingApproval(instance);
                assert.equal(contextApproval.source, "mcp");
                assert.equal(contextApproval.toolName, "environ_info");
                await instance.decideApproval(contextApproval.approvalId, {
                    decidedBy: "cli",
                    decision: "approve",
                    reason: "approved MCP environment bootstrap",
                });
                const ctxId = await contextPromise;

                callPromise = postJson(
                    endpoint,
                    withToolContext(
                        await readFixture("mcp-tools-call.json"),
                        ctxId,
                    ),
                    sessionHeaders,
                );

                const pendingApproval = await waitForPendingApproval(instance);
                assert.equal(pendingApproval.status, "pending");
                assert.equal(pendingApproval.source, "mcp");
                assert.equal(pendingApproval.toolName, "bash_run");
                assert.equal(
                    (await instance.readToolCalls()).some(
                        (record) =>
                            record.source === "mcp" &&
                            record.status === "pendingApproval",
                    ),
                    true,
                );

                await instance.decideApproval(pendingApproval.approvalId, {
                    decidedBy: "cli",
                    decision: "approve",
                    reason: "approved in mcp test",
                });

                const call = await callPromise;
                callPromise = undefined;
                assert.equal(call.error, undefined);
                assert.equal(call.result?.isError, false);

                const toolCalls = await instance.readToolCalls();
                const approvedToolCall = toolCalls.find(
                    (record) => record.toolName === "bash_run",
                );
                assert.equal(approvedToolCall?.source, "mcp");
                assert.equal(approvedToolCall?.decision, "approved");
                assert.equal(approvedToolCall?.status, "completed");

                deniedPromise = postJson(
                    endpoint,
                    withToolContext(
                        await readFixture("mcp-tools-call.json"),
                        ctxId,
                    ),
                    sessionHeaders,
                );

                const deniedApproval = await waitForPendingApproval(instance);
                await instance.decideApproval(deniedApproval.approvalId, {
                    decidedBy: "cli",
                    decision: "deny",
                    reason: "denied in mcp test",
                });

                const denied = await deniedPromise;
                deniedPromise = undefined;
                assert.equal(
                    denied.error?.data?.code,
                    errorCodes.coreApprovalDenied,
                );

                const replay = instance.subscribe(1);
                assert.equal(replay.kind, "events");
                assert.equal(
                    replay.events.some(
                        (event) => event.type === "approval.requested",
                    ),
                    true,
                );
                assert.equal(
                    replay.events.some(
                        (event) => event.type === "approval.approved",
                    ),
                    true,
                );
                assert.equal(
                    replay.events.some(
                        (event) => event.type === "approval.denied",
                    ),
                    true,
                );
                assert.equal(
                    replay.events.some(
                        (event) => event.type === "mcp.toolCalled",
                    ),
                    true,
                );

                const records = await instance.readToolCalls();
                assert.equal(
                    records.some(
                        (record) =>
                            record.source === "mcp" &&
                            record.status === "denied",
                    ),
                    true,
                );
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
        },
    );

    async function createContext(
        endpoint: string,
        headers: Record<string, string>,
        workspace: string,
    ): Promise<string> {
        const response = await postJson(
            endpoint,
            {
                id: `req-environ-${Date.now()}`,
                jsonrpc: "2.0",
                method: "tools/call",
                params: { arguments: { workspace }, name: "environ_info" },
            },
            headers,
        );
        const ctxId = response.result?.structuredContent?.ctxId;
        const memoryDirectory =
            response.result?.structuredContent?.projectMemoryDirectory;
        const memoryAgentFile =
            response.result?.structuredContent?.projectMemoryAgentFile;
        const temporaryDirectory =
            response.result?.structuredContent?.temporaryDirectory;
        assert.ok(typeof ctxId === "string");
        assert.equal(memoryDirectory, undefined);
        assert.equal(memoryAgentFile, undefined);
        assert.ok(typeof temporaryDirectory === "string");
        assert.equal((await stat(temporaryDirectory)).isDirectory(), true);
        return ctxId;
    }

    function withToolContext(body: JsonValue, ctxId: string): JsonValue {
        const request = structuredClone(body) as {
            params?: { arguments?: Record<string, JsonValue> };
        };
        request.params ??= {};
        request.params.arguments = {
            ...(request.params.arguments ?? {}),
            ctxId,
            timeoutMs: 30_000,
        };
        return request as JsonValue;
    }

    async function postJson(
        url: string,
        body: JsonValue,
        extraHeaders?: Record<string, string>,
    ): Promise<JsonRpcResponse> {
        const response = await postRawJson(url, body, extraHeaders);

        assert.equal(response.status, 200);
        return {
            headers: response.headers,
            ...parseMcpHttpResponse<Omit<JsonRpcResponse, "headers">>(
                response.text,
            ),
        };
    }

    async function postRawJson(
        url: string,
        body: JsonValue,
        extraHeaders?: Record<string, string>,
    ) {
        const response = await fetch(url, {
            body: JSON.stringify(body),
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json",
                ...extraHeaders,
            },
            method: "POST",
        });

        return {
            headers: response.headers,
            status: response.status,
            text: await response.text(),
        };
    }

    async function readFixture(name: string): Promise<JsonValue> {
        return JSON.parse(
            await readFile(resolve(fixturesDirectory, name), "utf8"),
        ) as JsonValue;
    }

    async function waitForPendingApproval(instance: {
        listApprovals(): Promise<
            Array<{
                approvalId: string;
                source: string;
                status: string;
                toolName: string;
            }>
        >;
    }): Promise<{
        approvalId: string;
        source: string;
        status: string;
        toolName: string;
    }> {
        for (let attempt = 0; attempt < 50; attempt += 1) {
            const pending = (await instance.listApprovals()).find(
                (approval) => approval.status === "pending",
            );

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
            input: { decidedBy: "cli"; decision: "deny"; reason: string },
        ): Promise<unknown>;
        listApprovals(): Promise<Array<{ approvalId: string; status: string }>>;
    }): Promise<void> {
        const pendingApprovals = (await instance.listApprovals()).filter(
            (approval) => approval.status === "pending",
        );

        for (const approval of pendingApprovals) {
            await instance.decideApproval(approval.approvalId, {
                decidedBy: "cli",
                decision: "deny",
                reason: "cleanup pending MCP approval",
            });
        }
    }
}

{
    const workerBinaryPath = resolveTestWorkerBinary();

    type JsonValue =
        | boolean
        | number
        | null
        | string
        | JsonValue[]
        | { [key: string]: JsonValue };

    test(
        "MCP tmux supports a complete interactive lifecycle when JSON-RPC request ids are reused",
        tmuxTestOptions(workerBinaryPath),
        async () => {
            await withTmuxHarness(
                "aromatic-mcp-tmux-lifecycle",
                async ({ callTool, createContext, listTools }) => {
                    const tools = await listTools();
                    const runTool = tools.find(
                        (entry) => entry.name === "tmux_run",
                    );
                    assert.notEqual(runTool, undefined);
                    assert.equal(
                        runTool?.inputSchema.properties?.timeMs,
                        undefined,
                    );
                    assert.equal(
                        runTool?.inputSchema.properties?.resume,
                        undefined,
                    );
                    assert.equal(
                        runTool?.inputSchema.properties?.consumeOutput,
                        undefined,
                    );
                    assert.notEqual(
                        runTool?.inputSchema.properties?.timeout,
                        undefined,
                    );
                    const readTool = tools.find(
                        (entry) => entry.name === "tmux_read",
                    );
                    assert.notEqual(readTool, undefined);
                    assert.equal(
                        readTool?.inputSchema.properties?.consumeOutput,
                        undefined,
                    );
                    assert.equal(
                        readTool?.inputSchema.properties?.timeMs?.minimum,
                        0,
                    );
                    assert.equal(
                        readTool?.inputSchema.properties?.timeMs?.maximum,
                        3_600_000,
                    );
                    const inputTool = tools.find(
                        (entry) => entry.name === "tmux_input",
                    );
                    assert.equal(inputTool?.inputSchema.type, "object");
                    assert.equal(inputTool?.inputSchema.anyOf, undefined);
                    assert.equal(inputTool?.inputSchema.oneOf, undefined);
                    for (const property of ["ctxId", "input", "task", "pane"]) {
                        assert.notEqual(
                            inputTool?.inputSchema.properties?.[property],
                            undefined,
                            property,
                        );
                    }
                    assert.equal(
                        inputTool?.inputSchema.properties?.timeMs,
                        undefined,
                    );
                    assert.equal(
                        inputTool?.inputSchema.properties?.line,
                        undefined,
                    );
                    assert.equal(
                        inputTool?.inputSchema.required?.includes("ctxId"),
                        true,
                    );
                    assert.equal(
                        inputTool?.inputSchema.required?.includes("input"),
                        true,
                    );
                    assert.equal(
                        tools.some((entry) => entry.name === "tmux_run"),
                        true,
                    );
                    const ctxId = await createContext();
                    const requestId = "reused-tools-call-id";
                    const created = await callTool(requestId, "tmux_manage", {
                        command: "create",
                        ctxId,
                        name: "interactive",
                    });
                    assert.equal(
                        created.error,
                        undefined,
                        JSON.stringify(created),
                    );

                    const run = await callTool(requestId, "tmux_run", {
                        command:
                            "read -r value; printf 'received:%s\\n' \"$value\"",
                        ctxId,
                        wait: "nonblock",
                    });
                    assert.equal(run.error, undefined, JSON.stringify(run));
                    const task = readString(
                        run.result?.structuredContent?.task?.id,
                        "tmux_run task id",
                    );

                    const input = await callTool(requestId, "tmux_input", {
                        ctxId,
                        input: "hello^M",
                        line: 100,
                        task,
                        timeMs: 1000,
                    });
                    assert.equal(input.error, undefined, JSON.stringify(input));
                    const output = [
                        ...(input.result?.structuredContent?.output ?? []),
                    ];

                    const finished = await waitForTask(
                        callTool,
                        requestId,
                        ctxId,
                        task,
                    );
                    output.push(...finished.output);
                    assert.notEqual(finished.task.status, "running");
                    assert.equal(
                        output.some((line) => line.includes("received:hello")),
                        true,
                        JSON.stringify({ finished, output }),
                    );

                    const closed = await callTool(requestId, "tmux_manage", {
                        command: "close",
                        ctxId,
                        pane: "interactive",
                    });
                    assert.equal(
                        closed.error,
                        undefined,
                        JSON.stringify(closed),
                    );
                    assert.equal(
                        closed.result?.structuredContent?.closedPaneId,
                        created.result?.structuredContent?.pane?.id,
                    );
                },
            );
        },
    );

    test(
        "MCP tmux block wait returns the full unread transcript instead of discarding it",
        tmuxTestOptions(workerBinaryPath),
        async () => {
            await withTmuxHarness(
                "aromatic-mcp-tmux-block-output",
                async ({ callTool, createContext, readToolCalls }) => {
                    const ctxId = await createContext();
                    const result = await callTool("block-output", "tmux_run", {
                        command: "printf 'EARLY\\n'; printf 'LATE\\n'",
                        ctxId,
                        line: 80,
                        timeout: 30_000,
                        wait: "block",
                    });
                    assert.equal(
                        result.error,
                        undefined,
                        JSON.stringify(result),
                    );
                    assert.notEqual(
                        result.result?.structuredContent?.task?.status,
                        "running",
                    );
                    const output =
                        result.result?.structuredContent?.output ?? [];
                    assert.equal(
                        output.some((line) => line === "EARLY"),
                        true,
                        JSON.stringify(result),
                    );
                    assert.equal(
                        output.some((line) => line === "LATE"),
                        true,
                        JSON.stringify(result),
                    );
                    const toolCalls = await readToolCalls();
                    const tmuxRuns = toolCalls.filter(
                        (record) => record.toolName === "tmux_run",
                    );
                    assert.equal(tmuxRuns.length, 1, JSON.stringify(tmuxRuns));
                    assert.equal(
                        (
                            tmuxRuns[0]?.input as
                                Record<string, JsonValue> | undefined
                        )?.wait,
                        "block",
                    );
                    assert.equal(
                        toolCalls.filter(
                            (record) => record.toolName === "tmux_read",
                        ).length,
                        0,
                        JSON.stringify(toolCalls),
                    );
                },
            );
        },
    );

    test(
        "MCP tmux block timeout returns current transcript without a follow-up read",
        tmuxTestOptions(workerBinaryPath),
        async () => {
            await withTmuxHarness(
                "aromatic-mcp-tmux-block-timeout-output",
                async ({ callTool, createContext, readToolCalls }) => {
                    const ctxId = await createContext();
                    const result = await callTool(
                        "block-timeout-output",
                        "tmux_run",
                        {
                            command: "printf 'EARLY\\n'; sleep 2",
                            ctxId,
                            line: -20,
                            timeout: 300,
                            wait: "block",
                        },
                    );
                    assert.equal(
                        result.error,
                        undefined,
                        JSON.stringify(result),
                    );
                    assert.equal(
                        result.result?.structuredContent?.task?.status,
                        "running",
                        JSON.stringify(result),
                    );
                    assert.equal(
                        result.result?.structuredContent?.timedOut,
                        true,
                        JSON.stringify(result),
                    );
                    const output =
                        result.result?.structuredContent?.output ?? [];
                    assert.equal(
                        output.some((line) => line === "EARLY"),
                        true,
                        JSON.stringify(result),
                    );

                    const task = readString(
                        result.result?.structuredContent?.task?.id,
                        "tmux_run task id",
                    );
                    const closed = await callTool(
                        "block-timeout-close",
                        "tmux_manage",
                        { command: "close", ctxId, force: true, task },
                    );
                    assert.equal(
                        closed.error,
                        undefined,
                        JSON.stringify(closed),
                    );

                    const toolCalls = await readToolCalls();
                    assert.equal(
                        toolCalls.filter(
                            (record) => record.toolName === "tmux_run",
                        ).length,
                        1,
                        JSON.stringify(toolCalls),
                    );
                    assert.equal(
                        toolCalls.filter(
                            (record) => record.toolName === "tmux_read",
                        ).length,
                        0,
                        JSON.stringify(toolCalls),
                    );
                },
            );
        },
    );

    test(
        "MCP tmux lets a refreshed context continue a task while preserving busy checks",
        tmuxTestOptions(workerBinaryPath),
        async () => {
            await withTmuxHarness(
                "aromatic-mcp-tmux-cross-context",
                async ({ callTool, createContext }) => {
                    const firstCtxId = await createContext();
                    const refreshedCtxId = await createContext();
                    const requestId = "reused-tools-call-id";
                    const created = await callTool(requestId, "tmux_manage", {
                        command: "create",
                        ctxId: firstCtxId,
                        name: "continued",
                    });
                    assert.equal(
                        created.error,
                        undefined,
                        JSON.stringify(created),
                    );

                    const paneInput = await callTool(requestId, "tmux_input", {
                        ctxId: firstCtxId,
                        input: "sleep 10^M",
                        pane: "continued",
                    });
                    assert.equal(
                        paneInput.error,
                        undefined,
                        JSON.stringify(paneInput),
                    );

                    const run = await callTool(requestId, "tmux_run", {
                        command: "sleep 10",
                        ctxId: firstCtxId,
                        wait: "nonblock",
                    });
                    assert.equal(run.error, undefined, JSON.stringify(run));
                    assert.equal(
                        run.result?.structuredContent?.pane
                            ?.ownedByCurrentContext,
                        undefined,
                    );
                    const task = readString(
                        run.result?.structuredContent?.task?.id,
                        "tmux_run task id",
                    );

                    const read = await callTool(requestId, "tmux_read", {
                        ctxId: refreshedCtxId,
                        task,
                    });
                    assert.equal(read.error, undefined, JSON.stringify(read));

                    const foreground = await callTool(requestId, "tmux_input", {
                        ctxId: refreshedCtxId,
                        input: "sleep 10^M",
                        pane: "continued",
                    });
                    assert.equal(
                        foreground.error,
                        undefined,
                        JSON.stringify(foreground),
                    );
                    await new Promise((resolve) => setTimeout(resolve, 100));

                    const busyClose = await callTool(requestId, "tmux_manage", {
                        command: "close",
                        ctxId: refreshedCtxId,
                        pane: "continued",
                    });
                    assert.equal(
                        busyClose.error?.data?.code,
                        "tmux.paneBusy",
                        JSON.stringify(busyClose),
                    );

                    const interrupted = await callTool(
                        requestId,
                        "tmux_input",
                        {
                            ctxId: refreshedCtxId,
                            input: "^C",
                            task,
                            timeMs: 1000,
                        },
                    );
                    assert.equal(
                        interrupted.error,
                        undefined,
                        JSON.stringify(interrupted),
                    );
                    const finished = await waitForTask(
                        callTool,
                        requestId,
                        refreshedCtxId,
                        task,
                    );
                    assert.notEqual(finished.task.status, "running");

                    const stopForeground = await callTool(
                        requestId,
                        "tmux_input",
                        {
                            ctxId: refreshedCtxId,
                            input: "^C",
                            pane: "continued",
                        },
                    );
                    assert.equal(
                        stopForeground.error,
                        undefined,
                        JSON.stringify(stopForeground),
                    );
                    await new Promise((resolve) => setTimeout(resolve, 100));

                    const closed = await callTool(requestId, "tmux_manage", {
                        command: "close",
                        ctxId: refreshedCtxId,
                        force: true,
                        pane: "continued",
                    });
                    assert.equal(
                        closed.error,
                        undefined,
                        JSON.stringify(closed),
                    );
                    assert.equal(
                        closed.result?.structuredContent?.closedPaneId,
                        created.result?.structuredContent?.pane?.id,
                    );
                },
            );
        },
    );

    interface ToolStructuredContent {
        closedPaneId?: string;
        ctxId?: string;
        output?: string[];
        pane?: { id?: string; ownedByCurrentContext?: boolean };
        task?: { id?: string; status?: string };
        timedOut?: boolean;
    }

    interface ToolSummary {
        description?: string;
        inputSchema: {
            anyOf?: JsonValue[];
            oneOf?: JsonValue[];
            properties?: Record<
                string,
                { description?: string; maximum?: number; minimum?: number }
            >;
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
        callTool(
            requestId: string,
            name: string,
            args: Record<string, JsonValue>,
        ): Promise<ToolResponse>;
        createContext(): Promise<string>;
        listTools(): Promise<ToolSummary[]>;
        readToolCalls(): Promise<ToolCallRecord[]>;
    }

    async function withTmuxHarness(
        instanceName: string,
        body: (harness: TmuxHarness) => Promise<void>,
    ): Promise<void> {
        const homeDirectory = await createTestTempDirectory("mcp-tmux-home");
        const runtimeDirectory = await mkdtemp(
            join(
                process.platform === "darwin" ? "/tmp" : tmpdir(),
                "pds-mcp-tmux-",
            ),
        );
        const workspacePath =
            await createTestTempDirectory("mcp-tmux-workspace");
        const instance = new WorkerInstanceFactory().create({
            env: {
                ...process.env,
                HOME: homeDirectory,
                XDG_RUNTIME_DIR: runtimeDirectory,
            },
            homeDirectory,
            name: asInstanceName(instanceName),
            transport: new WorkerTransportDriverLocal({
                spawnFunction: nodeSpawn,
                workerBinary: new WorkerBinary(workerBinaryPath!),
            }),
        });
        const host = new McpHost({
            instances: [
                {
                    auth: { enabled: false, provider: "none" },
                    name: instanceName,
                    worker: instance,
                },
            ],
            listenHost: "127.0.0.1",
            listenPort: 0,
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
                    protocolVersion: "2025-06-18",
                },
            });
            assert.equal(
                initialize.error,
                undefined,
                JSON.stringify(initialize),
            );
            const headers = {
                "mcp-protocol-version": String(
                    initialize.result?.protocolVersion ?? "",
                ),
            };
            assert.equal(initialize.headers.get("mcp-session-id"), null);
            const initialized = await postRawJson(
                endpoint,
                {
                    jsonrpc: "2.0",
                    method: "notifications/initialized",
                },
                headers,
            );
            assert.equal(initialized.status, 202);

            const callTool = async (
                requestId: string,
                name: string,
                args: Record<string, JsonValue>,
            ): Promise<ToolResponse> =>
                (await postJson(
                    endpoint,
                    {
                        id: requestId,
                        jsonrpc: "2.0",
                        method: "tools/call",
                        params: { arguments: args, name },
                    },
                    headers,
                )) as ToolResponse;
            const createContext = async (): Promise<string> => {
                const response = await callTool(
                    "reused-environ-id",
                    "environ_info",
                    { workspace: workspacePath },
                );
                assert.equal(
                    response.error,
                    undefined,
                    JSON.stringify(response),
                );
                return readString(
                    response.result?.structuredContent?.ctxId,
                    "environ_info ctxId",
                );
            };
            const listTools = async () => {
                const response = await postJson(
                    endpoint,
                    {
                        id: "list-tools",
                        jsonrpc: "2.0",
                        method: "tools/list",
                    },
                    headers,
                );
                return response.result?.tools ?? [];
            };

            const readToolCalls = async (): Promise<ToolCallRecord[]> =>
                await instance.readToolCalls();
            await body({ callTool, createContext, listTools, readToolCalls });
        } finally {
            await host.stop();
            const runtimeInstanceDirectory = join(
                runtimeDirectory,
                "devshell-worker",
                instanceName,
            );
            const sockets = (
                await readdir(runtimeInstanceDirectory).catch(() => [])
            ).filter(
                (name) => name === "tmux.sock" || /^tmux-.+\.sock$/u.test(name),
            );
            for (const socket of sockets) {
                const cleanup = spawnSync(
                    "tmux",
                    [
                        "-S",
                        join(runtimeInstanceDirectory, socket),
                        "kill-server",
                    ],
                    {
                        encoding: "utf8",
                    },
                );
                assert.equal(
                    cleanup.status,
                    0,
                    cleanup.stderr ||
                        cleanup.error?.message ||
                        "failed to stop test tmux server",
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
        task: string,
    ): Promise<{ output: string[]; task: { status: string } }> {
        const waited = await callTool(requestId, "tmux_read", {
            ctxId,
            line: 200,
            task,
            timeMs: 30_000,
        });
        assert.equal(waited.error, undefined, JSON.stringify(waited));
        const status = readString(
            waited.result?.structuredContent?.task?.status,
            "tmux_read task status",
        );
        assert.notEqual(status, "running");

        const read = await callTool(requestId, "tmux_read", {
            ctxId,
            line: 200,
            task,
        });
        assert.equal(read.error, undefined, JSON.stringify(read));
        return {
            output: [...(read.result?.structuredContent?.output ?? [])],
            task: { status },
        };
    }

    function readString(value: unknown, name: string): string {
        if (typeof value !== "string") {
            throw new TypeError(`${name} must be a string`);
        }
        return value;
    }

    async function postJson(
        url: string,
        body: JsonValue,
        extraHeaders?: Record<string, string>,
    ): Promise<JsonRpcResponse> {
        const response = await postRawJson(url, body, extraHeaders);
        assert.equal(response.status, 200, response.text);
        return {
            headers: response.headers,
            ...parseMcpHttpResponse<ToolResponse>(response.text),
        };
    }

    async function postRawJson(
        url: string,
        body: JsonValue,
        extraHeaders?: Record<string, string>,
    ) {
        const response = await fetch(url, {
            body: JSON.stringify(body),
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json",
                ...extraHeaders,
            },
            method: "POST",
        });
        return {
            headers: response.headers,
            status: response.status,
            text: await response.text(),
        };
    }
}
