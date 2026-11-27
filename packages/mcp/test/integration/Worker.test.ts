import assert from "node:assert/strict";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import {
    readFile,
    rm,
    stat,
    writeFile,
    mkdtemp,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { requireTcpPort } from "../../../../test/TestHttpSupport.ts";
import {
    asInstanceName,
    type ToolCallRecord,
} from "@portable-devshell/shared";
import {
    createTestInstance,
    TestMcpHost as McpHost,
} from "../ContextRuntime.ts";
import {
    readRelativeMarkerCommand,
    realWorkerTestOptions,
    resolveTestWorkerBinary,
} from "../../../../test/TestPlatformSupport.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { parseMcpHttpResponse } from "../TestMcpHttpResponse.ts";
import {
    MODERN_PROTOCOL_VERSION,
    modernRpcHeaders,
    modernRpcRequest,
} from "./ModernProtocol.ts";
import { tmpdir } from "node:os";

{
    const fixturesDirectory = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../fixtures",
    );
    const workerBinaryPath = resolveTestWorkerBinary();
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
            supportedVersions?: string[];
            tools?: JsonValue[];
        };
    }

    function asRecord(
        value: JsonValue | undefined,
    ): Record<string, JsonValue> | undefined {
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? value
            : undefined;
    }

    function assertLocalReferencesResolve(schema: Record<string, unknown>): void {
        function visit(value: unknown): void {
            if (Array.isArray(value)) {
                for (const entry of value) visit(entry);
                return;
            }
            if (typeof value !== "object" || value === null) return;
            const record = value as Record<string, unknown>;
            if (typeof record.$ref === "string" && record.$ref.startsWith("#/")) {
                let target: unknown = schema;
                for (const token of record.$ref.slice(2).split("/")) {
                    const key = decodeURIComponent(token)
                        .replaceAll("~1", "/").replaceAll("~0", "~");
                    assert.ok(typeof target === "object" && target !== null, record.$ref);
                    assert.ok(Object.hasOwn(target, key), record.$ref);
                    target = (target as Record<string, unknown>)[key];
                }
                assert.notEqual(target, undefined, record.$ref);
            }
            for (const entry of Object.values(record)) visit(entry);
        }
        visit(schema);
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
            const instance = createTestInstance({
                env: { ...process.env, HOME: homeDirectory },
                homeDirectory,
                name: asInstanceName(instanceName),
                workerBinaryPath: workerBinaryPath!,
            });
            const host = new McpHost({
                instances: [
                    {
                        auth: { enabled: false, provider: "none" },
                        name: instanceName,
                        worker: instance.worker,
                    },
                ],
                listenHost: "127.0.0.1",
                listenPort: 0,
                resolveTarget: () => instance.target(),
            });

            try {
                await instance.start();
                await host.start();

                const port = requireTcpPort(host.server.address);
                const endpoint = `http://127.0.0.1:${port}/${instanceName}/mcp/explicit`;

                const discovery = await postJson(
                    endpoint,
                    modernRpcRequest("req-init", "server/discover"),
                );
                assert.equal(discovery.error, undefined);
                assert.equal(
                    discovery.result?.supportedVersions?.includes(
                        MODERN_PROTOCOL_VERSION,
                    ),
                    true,
                );
                assert.equal(discovery.headers.get("mcp-session-id"), null);

                const list = await postJson(
                    endpoint,
                    {
                        id: "req-tools-list",
                        jsonrpc: "2.0",
                        method: "tools/list",
                    },
                );
                assert.equal(list.error, undefined);
                const tools = list.result?.tools as Array<{
                    description: string;
                    inputSchema: Record<string, unknown>;
                    name: string;
                }>;
                for (const tool of tools) {
                    assertLocalReferencesResolve(tool.inputSchema);
                }
                const bash = tools.find((tool) => tool.name === "bash_run");
                const fileRead = tools.find(
                    (tool) => tool.name === "file_read",
                );
                assert.notEqual(bash, undefined);
                assert.notEqual(fileRead, undefined);
                assert.notEqual(
                    (fileRead?.inputSchema.properties as Record<string, unknown>).files,
                    undefined,
                );
                assert.equal(
                    (fileRead?.inputSchema.properties as Record<string, unknown>).path,
                    undefined,
                );
                const workerBash = instance.listTools().find((tool) => tool.name === "bash_run");
                const workerBashSchema = workerBash?.inputSchema as Record<string, unknown>;
                assert.equal(bash?.description, workerBash?.description);
                assert.match(bash?.description ?? "", /task_input/u);
                assert.deepEqual(
                    Object.fromEntries(Object.entries(bash?.inputSchema ?? {}).filter(([key]) =>
                        !["$schema", "properties", "required", "title"].includes(key))),
                    Object.fromEntries(Object.entries(workerBashSchema).filter(([key]) =>
                        !["$schema", "properties", "required", "title"].includes(key))),
                );
                assert.equal(
                    (bash?.inputSchema.properties as Record<string, unknown>).ctxId !== undefined,
                    true,
                );
                assert.equal((bash?.inputSchema.required as string[]).includes("ctxId"), true);
                for (const name of [
                    "task_input", "task_inspect", "task_manage",
                    "file_glob", "file_grep",
                ]) {
                    const tool = tools.find((entry) => entry.name === name);
                    assert.notEqual(tool, undefined, name);
                    assert.equal(tool?.inputSchema.type, "object", name);
                    assert.notEqual(tool?.inputSchema.properties, undefined, name);
                    assert.equal((tool?.inputSchema.required as string[]).includes("ctxId"), true, name);
                    const worker = instance.listTools().find((entry) => entry.name === name);
                    assert.equal(tool?.description, worker?.description, name);
                }
                for (const retired of [
                    "file_find", "file_info", "file_search",
                    "task_read",
                    "tmux_run", "tmux_read", "tmux_input", "tmux_inspect", "tmux_manage",
                ]) {
                    assert.equal(tools.some((tool) => tool.name === retired), false, retired);
                }

                const ctxId = await createContext(
                    endpoint,
                    selectedWorkspacePath,
                );
                const batchRead = await postJson(
                    endpoint,
                    {
                        id: "req-file-read-batch",
                        jsonrpc: "2.0",
                        method: "tools/call",
                        params: {
                            arguments: {
                                ctxId,
                                files: [
                                    {
                                        path: "./legacy-read.txt",
                                        selector: "1-1:raw",
                                        view: "content",
                                    },
                                ],
                            },
                            name: "file_read",
                        },
                    },
                );
                assert.equal(
                    batchRead.error,
                    undefined,
                    JSON.stringify(batchRead),
                );
                assert.equal(batchRead.result?.isError, false);
                assert.equal(
                    (
                        batchRead.result?.structuredContent as
                            | { files?: Array<{ content?: JsonValue }> }
                            | undefined
                    )?.files?.[0]?.content,
                    "1:legacy read",
                );
                const callRequest = withToolContext(
                    await readFixture("mcp-tools-call.json"),
                    ctxId,
                ) as { params: { arguments: Record<string, JsonValue> } };
                callRequest.params.arguments.command =
                    readRelativeMarkerCommand(workspaceMarkerName);
                const call = await postJson(
                    endpoint,
                    callRequest as JsonValue,
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
                    join(homeDirectory, "audit.sqlite"),
                );
                assert.equal(auditDatabase.size > 0, true);
                // Instance ToolCall Audit is authoritative; MCP no longer emits a separate mcp.toolCalled event.
            } finally {
                await host.stop();
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

    async function createContext(
        endpoint: string,
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
        );
        const ctxId = response.result?.structuredContent?.ctxId;
        assert.ok(typeof ctxId === "string");
        assert.ok(Array.isArray(response.result?.structuredContent?.comment));
        assert.equal(response.result?.structuredContent?.temporaryDirectory, undefined);
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
            waitMs: 30_000,
        };
        return request as JsonValue;
    }

    async function postJson(
        url: string,
        body: JsonValue | Record<string, unknown>,
    ): Promise<JsonRpcResponse> {
        const request = body as {
            id?: string | number;
            method?: string;
            params?: Record<string, JsonValue>;
        };
        if (typeof request.method !== "string") {
            throw new TypeError("postJson requires a JSON-RPC method");
        }
        const params = request.params ?? {};
        const response = await postRawJson(
            url,
            modernRpcRequest(
                request.id ?? request.method,
                request.method,
                params,
            ),
            modernRpcHeaders(request.method, params),
        );

        assert.equal(response.status, 200, response.text);
        return {
            headers: response.headers,
            ...parseMcpHttpResponse<Omit<JsonRpcResponse, "headers">>(
                response.text,
            ),
        };
    }

    async function postRawJson(
        url: string,
        body: JsonValue | Record<string, unknown>,
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
        "MCP exposes one shell entry and the complete process task/terminal API",
        realWorkerTestOptions(workerBinaryPath),
        async () => {
            await withProcessHarness(
                "aromatic-mcp-process-catalog",
                async ({ listTools }) => {
                    const tools = await listTools();
                    const names = new Set(tools.map((tool) => tool.name));
                    for (const name of [
                        "bash_run", "task_input",
                        "task_inspect", "task_manage",
                    ]) assert.equal(names.has(name), true, name);
                    for (const name of [
                        "task_read",
                        "tmux_run", "tmux_read", "tmux_input",
                        "tmux_inspect", "tmux_manage",
                    ]) assert.equal(names.has(name), false, name);

                    const bash = tools.find((tool) => tool.name === "bash_run");
                    const taskInput = tools.find((tool) => tool.name === "task_input");
                    const terminalManage = tools.find((tool) => tool.name === "task_manage");
                    assert.ok(bash);
                    assert.ok(taskInput);
                    assert.ok(terminalManage);
                    assert.match(bash.description ?? "", /task_input/u);
                    assert.match(bash.description ?? "", /waitMs/u);
                    assert.equal(bash.inputSchema.properties?.waitMs?.minimum, 0);
                    assert.equal(bash.inputSchema.properties?.pty?.type, "boolean");
                    assert.notEqual(taskInput.inputSchema.properties?.cursor, undefined);
                    assert.equal(taskInput.inputSchema.properties?.untilExit?.type, "boolean");
                    assert.equal(taskInput.inputSchema.required?.includes("task"), true);
                    assert.ok((taskInput.inputSchema.properties?.input?.type as string[]).includes("string"));
                    assert.match(terminalManage.inputSchema.properties?.command?.description ?? "",
                        /If state is still running, poll with task_manage\(command="list"\)/u);
                    const statelessManage = (await listTools("stateless")).find((tool) => tool.name === "task_manage");
                    assert.equal(statelessManage?.inputSchema.properties?.command?.description,
                        terminalManage.inputSchema.properties?.command?.description);
                },
            );
        },
    );

    test(
        "MCP bash_run starts one PTY that task_input continues",
        realWorkerTestOptions(workerBinaryPath),
        async () => {
            await withProcessHarness(
                "aromatic-mcp-process-interactive",
                async ({ callTool, createContext }) => {
                    const ctxId = await createContext();
                    const command = process.platform === "win32"
                        ? '[Console]::WriteLine("READY"); $value = [Console]::ReadLine(); [Console]::WriteLine("received:$value")'
                        : "stty -echo; printf 'READY\\n'; IFS= read -r value; printf 'received:%s\\n' \"$value\"";
                    const started = await callTool("reused-process-call", "bash_run", {
                        command, ctxId, pty: true, waitMs: 50,
                    });
                    assert.equal(started.error, undefined, JSON.stringify(started));
                    const task = readString(started.result?.structuredContent?.task?.id, "task id");
                    assert.equal(started.result?.structuredContent?.termination, "running");

                    const listed = await callTool("reused-process-call", "task_manage", {
                        command: "list", ctxId,
                    });
                    assert.equal(listed.error, undefined, JSON.stringify(listed));
                    assert.ok(listed.result?.structuredContent?.tasks?.some((entry) => entry.id === task));

                    const inspected = await callTool("reused-process-call", "task_inspect", {
                        ctxId, task,
                    });
                    assert.equal(inspected.error, undefined, JSON.stringify(inspected));

                    const finished = await callTool("reused-process-call", "task_input", {
                        ctxId, task, input: "hello\r",
                        ...(started.result?.structuredContent?.cursor === undefined ? {} : { cursor: started.result.structuredContent.cursor }),
                        waitMs: 10_000, untilExit: true,
                    });
                    assert.equal(finished.error, undefined, JSON.stringify(finished));
                    assert.equal(finished.result?.structuredContent?.exitCode, 0);
                    assert.equal(finished.result?.structuredContent?.termination, "exited");
                    const output = (started.result?.structuredContent?.stdout ?? "") +
                        (finished.result?.structuredContent?.stdout ?? "");
                    assert.match(output, /READY/u);
                    assert.match(output, /received:hello/u);
                },
            );
        },
    );

    test(
        "MCP bash_run waitMs is a soft wait and task_input resumes from an independent cursor",
        realWorkerTestOptions(workerBinaryPath),
        async () => {
            await withProcessHarness(
                "aromatic-mcp-process-soft-wait",
                async ({ callTool, createContext, readToolCalls }) => {
                    const ctxId = await createContext();
                    const started = await callTool("soft-wait-start", "bash_run", {
                        command: process.platform === "win32"
                            ? 'Write-Output EARLY; Start-Sleep -Seconds 2; Write-Output LATE'
                            : "printf 'EARLY\\n'; sleep 2; printf 'LATE\\n'",
                        ctxId, waitMs: 250,
                    });
                    assert.equal(started.error, undefined, JSON.stringify(started));
                    assert.equal(started.result?.structuredContent?.termination, "running");
                    assert.equal(started.result?.structuredContent?.waitReason, "timeout");
                    assert.match(started.result?.structuredContent?.stdout ?? "", /EARLY/u);
                    const task = readString(started.result?.structuredContent?.task?.id, "task id");

                    const finished = await callTool("soft-wait-read", "task_input", {
                        ctxId, task,
                        ...(started.result?.structuredContent?.cursor === undefined ? {} : { cursor: started.result.structuredContent.cursor }),
                        waitMs: 10_000, untilExit: true,
                    });
                    assert.equal(finished.error, undefined, JSON.stringify(finished));
                    assert.equal(finished.result?.structuredContent?.waitReason, "terminal");
                    assert.notEqual(finished.result?.structuredContent?.task?.status, "running");
                    assert.match(finished.result?.structuredContent?.stdout ?? "", /LATE/u);
                    assert.doesNotMatch(finished.result?.structuredContent?.stdout ?? "", /EARLY/u);
                    const replay = await callTool("independent-read", "task_input", { ctxId, task });
                    assert.equal(replay.error, undefined, JSON.stringify(replay));
                    assert.match(replay.result?.structuredContent?.stdout ?? "", /EARLY[\s\S]*LATE/u);

                    const records = await readToolCalls();
                    assert.equal(records.filter((record) => record.toolName === "bash_run").length, 1);
                    assert.equal(records.filter((record) => record.toolName === "task_input").length, 2);
                },
            );
        },
    );

    test(
        "MCP terminal creation, input, inspection and close preserve one process across Context renewal",
        realWorkerTestOptions(workerBinaryPath),
        async () => {
            await withProcessHarness(
                "aromatic-mcp-process-terminal",
                async ({ callTool, createContext }) => {
                    const ctxId = await createContext();
                    const created = await callTool("terminal-create", "task_manage", {
                        ctxId, command: "create",
                        shell: process.platform === "win32"
                            ? "powershell.exe"
                            : "/bin/bash",
                    });
                    assert.equal(created.error, undefined, JSON.stringify(created));
                    const task = readString(created.result?.structuredContent?.task?.id, "terminal id");
                    assert.equal(created.result?.structuredContent?.task?.state, "running");
                    const renewed = await createContext();
                    const input = await callTool("terminal-write", "task_input", {
                        ctxId: renewed, task, input: process.platform === "win32"
                            ? "Write-Output ('TERMINAL-' + 'ALIVE')\r"
                            : "printf '%s%s\\n' 'TERMINAL-' 'ALIVE'\r",
                    });
                    assert.equal(input.error, undefined, JSON.stringify(input));
                    let stdout = input.result?.structuredContent?.stdout ?? "";
                    let cursor = input.result?.structuredContent?.cursor;
                    for (let i = 0; i < 30 && !stdout.includes("TERMINAL-ALIVE"); i++) {
                        const page = await callTool("terminal-read", "task_input", {
                            ctxId: renewed, task, ...(cursor === undefined ? {} : { cursor }), waitMs: 1000,
                        });
                        assert.equal(page.error, undefined, JSON.stringify(page));
                        stdout += page.result?.structuredContent?.stdout ?? "";
                        cursor = page.result?.structuredContent?.cursor ?? cursor;
                    }
                    assert.match(stdout, /TERMINAL-ALIVE/u);
                    const inspected = await callTool("terminal-screen", "task_inspect", {
                        ctxId: renewed, task,
                    });
                    assert.equal(inspected.error, undefined, JSON.stringify(inspected));
                    assert.match(inspected.result?.structuredContent?.text ?? "", /TERMINAL-ALIVE/u);
                    const closed = await callTool("terminal-close", "task_manage", {
                        ctxId: renewed, command: "close", task,
                    });
                    assert.equal(closed.error, undefined, JSON.stringify(closed));
                    assert.equal(closed.result?.structuredContent?.taskId, task);
                    assert.equal(closed.result?.structuredContent?.killRequested, true);
                    assert.match(closed.result?.structuredContent?.state ?? "", /^(running|exited)$/u);
                    assert.equal("closedTask" in (closed.result?.structuredContent ?? {}), false);
                    assert.equal("accepted" in (closed.result?.structuredContent ?? {}), false);

                    let finalStdout = "";
                    let finalCursor: string | undefined;
                    let waitReason: string | undefined;
                    for (let i = 0; i < 10 && waitReason !== "terminal"; i++) {
                        const page = await callTool("terminal-final", "task_input", {
                            ctxId: renewed, task, waitMs: 1000,
                            ...(finalCursor === undefined ? {} : { cursor: finalCursor }),
                        });
                        assert.equal(page.error, undefined, JSON.stringify(page));
                        finalStdout += page.result?.structuredContent?.stdout ?? "";
                        finalCursor = readString(page.result?.structuredContent?.cursor, "terminal cursor");
                        waitReason = page.result?.structuredContent?.waitReason;
                    }
                    assert.equal(waitReason, "terminal");
                    assert.match(finalStdout, /TERMINAL-ALIVE/u);
                },
            );
        },
    );

    test(
        "MCP synchronous bash_run returns full output without another tool call",
        realWorkerTestOptions(workerBinaryPath),
        async () => {
            await withProcessHarness(
                "aromatic-mcp-process-sync",
                async ({ callTool, createContext, readToolCalls }) => {
                    const ctxId = await createContext();
                    const result = await callTool("sync", "bash_run", {
                        ctxId, waitMs: 10000,
                        command: process.platform === "win32"
                            ? "Write-Output EARLY; Write-Output LATE"
                            : "printf 'EARLY\\n'; printf 'LATE\\n'",
                    });
                    assert.equal(result.error, undefined, JSON.stringify(result));
                    assert.equal(result.result?.structuredContent?.exitCode, 0);
                    assert.equal(result.result?.structuredContent?.waitReason, "terminal");
                    assert.match(result.result?.structuredContent?.stdout ?? "", /EARLY[\s\S]*LATE/u);
                    const records = await readToolCalls();
                    assert.equal(records.filter((record) => record.toolName === "bash_run").length, 1);
                    assert.equal(records.filter((record) => record.toolName === "task_input").length, 0);
                },
            );
        },
    );

    test(
        "MCP task resources remain available to a refreshed context in the same workspace",
        realWorkerTestOptions(workerBinaryPath),
        async () => {
            await withProcessHarness(
                "aromatic-mcp-process-context-refresh",
                async ({ callTool, createContext }) => {
                    const firstContext = await createContext();
                    const started = await callTool("context-task-start", "bash_run", {
                        command: process.platform === "win32"
                            ? 'Start-Sleep -Seconds 1; Write-Output CONTEXT-REFRESHED'
                            : "sleep 1; printf 'CONTEXT-REFRESHED\\n'",
                        ctxId: firstContext, waitMs: 0,
                    });
                    assert.equal(started.error, undefined, JSON.stringify(started));
                    const task = readString(started.result?.structuredContent?.task?.id, "task id");
                    const refreshedContext = await createContext();
                    const result = await callTool("context-task-read", "task_input", {
                        ctxId: refreshedContext, task,
                        ...(started.result?.structuredContent?.cursor === undefined ? {} : { cursor: started.result.structuredContent.cursor }),
                        waitMs: 10_000, untilExit: true,
                    });
                    assert.equal(result.error, undefined, JSON.stringify(result));
                    assert.match(result.result?.structuredContent?.stdout ?? "", /CONTEXT-REFRESHED/u);
                },
            );
        },
    );

    interface ToolStructuredContent {
        id?: string;
        taskId?: string;
        killRequested?: boolean;
        text?: string;
        ctxId?: string;
        state?: string;
        exitCode?: number;
        stdout?: string;
        stderr?: string;
        termination?: string;
        waitReason?: string;
        waitMs?: number;
        timedOut?: boolean;
        cursor?: string;
        task?: { id?: string; status?: string; state?: string; pty?: boolean };
        tasks?: Array<{ id?: string; state?: string }>;
    }

    interface ToolSummary {
        description?: string;
        inputSchema: {
            anyOf?: JsonValue[];
            oneOf?: JsonValue[];
            properties?: Record<
                string,
                { description?: string; maximum?: number; minimum?: number; type?: string | string[]; anyOf?: JsonValue[]; enum?: JsonValue[] }
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
            supportedVersions?: string[];
            tools?: ToolSummary[];
        };
    }

    interface JsonRpcResponse extends ToolResponse {
        headers: Headers;
    }

    interface ProcessHarness {
        callTool(
            requestId: string,
            name: string,
            args: Record<string, JsonValue>,
        ): Promise<ToolResponse>;
        createContext(): Promise<string>;
        listTools(mode?: "explicit" | "stateless"): Promise<ToolSummary[]>;
        readToolCalls(): Promise<ToolCallRecord[]>;
    }

    async function withProcessHarness(
        instanceName: string,
        body: (harness: ProcessHarness) => Promise<void>,
    ): Promise<void> {
        const homeDirectory = await createTestTempDirectory("mcp-process-home");
        const runtimeDirectory = await mkdtemp(
            join(
                process.platform === "darwin" ? "/tmp" : tmpdir(),
                "pds-mcp-process-",
            ),
        );
        const workspacePath =
            await createTestTempDirectory("mcp-process-workspace");
        const workerEnvironment = {
            ...process.env,
            HOME: homeDirectory,
            ...(process.platform === "win32"
                ? { USERPROFILE: homeDirectory }
                : {}),
            XDG_RUNTIME_DIR: runtimeDirectory,
        };
        const instance = createTestInstance({
            env: workerEnvironment,
            homeDirectory,
            name: asInstanceName(instanceName),
            workerBinaryPath: workerBinaryPath!,
        });
        const host = new McpHost({
            instances: [
                {
                    auth: { enabled: false, provider: "none" },
                    name: instanceName,
                    worker: instance.worker,
                },
            ],
            listenHost: "127.0.0.1",
            listenPort: 0,
            resolveTarget: () => instance.target(),
        });

        try {
            await instance.start();
            await host.start();
            const port = requireTcpPort(host.server.address);
            const endpoint = `http://127.0.0.1:${port}/${instanceName}/mcp/explicit`;
            const discovery = await postJson(
                endpoint,
                modernRpcRequest("server-discover", "server/discover"),
            );
            assert.equal(
                discovery.error,
                undefined,
                JSON.stringify(discovery),
            );
            assert.equal(
                discovery.result?.supportedVersions?.includes(
                    MODERN_PROTOCOL_VERSION,
                ),
                true,
            );
            assert.equal(discovery.headers.get("mcp-session-id"), null);

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
            const listTools = async (mode: "explicit" | "stateless" = "explicit") => {
                const response = await postJson(
                    `http://127.0.0.1:${port}/${instanceName}/mcp/${mode}`,
                    {
                        id: "list-tools",
                        jsonrpc: "2.0",
                        method: "tools/list",
                    },
                );
                return response.result?.tools ?? [];
            };

            const readToolCalls = async (): Promise<ToolCallRecord[]> =>
                await instance.readToolCalls();
            await body({ callTool, createContext, listTools, readToolCalls });
        } finally {
            await host.stop();
            await instance.close();
            const cleanup = spawnSync(
                workerBinaryPath!,
                ["retire", "--instance", instanceName],
                { encoding: "utf8", env: workerEnvironment, windowsHide: true },
            );
            assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.error?.message || "failed to retire test Process Host");
            await rm(homeDirectory, { force: true, recursive: true });
            await rm(runtimeDirectory, { force: true, recursive: true });
            await rm(workspacePath, { force: true, recursive: true });
        }
    }

    function readString(value: unknown, name: string): string {
        if (typeof value !== "string") {
            throw new TypeError(`${name} must be a string`);
        }
        return value;
    }

    async function postJson(
        url: string,
        body: JsonValue | Record<string, unknown>,
    ): Promise<JsonRpcResponse> {
        const request = body as {
            id?: string | number;
            method?: string;
            params?: Record<string, JsonValue>;
        };
        if (typeof request.method !== "string") {
            throw new TypeError("postJson requires a JSON-RPC method");
        }
        const params = request.params ?? {};
        const response = await postRawJson(
            url,
            modernRpcRequest(
                request.id ?? request.method,
                request.method,
                params,
            ),
            modernRpcHeaders(request.method, params),
        );
        assert.equal(response.status, 200, response.text);
        return {
            headers: response.headers,
            ...parseMcpHttpResponse<ToolResponse>(response.text),
        };
    }

    async function postRawJson(
        url: string,
        body: JsonValue | Record<string, unknown>,
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
