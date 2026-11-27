import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAcceptanceFixture, runCli } from "./AcceptanceSupport.mjs";

const applicationVersion = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;
const fixture = await createAcceptanceFixture();
try {
    runCli(["start"], fixture.env);
    runCli(["instance", "start", "aromatic-pc"], fixture.env);
    const endpoint = `http://127.0.0.1:${fixture.port}/aromatic-pc/mcp/explicit`;
    const statelessEndpoint = new URL("./stateless", endpoint).href;
    const listContexts = () => JSON.parse(runCli(["context", "list"], fixture.env).stdout);
    const contextsBefore = listContexts();
    const statelessList = await postJson(statelessEndpoint, {
        jsonrpc: "2.0", id: "req-stateless-list", method: "tools/list",
    });
    assert.equal(statelessList.headers.get("mcp-session-id"), null);
    const statelessTools = statelessList.body.result?.tools;
    assert.deepEqual(statelessTools?.map(({ name }) => name).sort(), [
        "bash_run", "file_edit", "file_glob", "file_grep", "file_read",
        "task_input", "task_inspect", "task_manage",
    ]);
    for (const tool of statelessTools) {
        assert.equal(Object.hasOwn(tool.inputSchema.properties, "ctxId"), false);
        assert.equal(Object.hasOwn(tool.inputSchema.properties, "instance"), false);
        assert.equal(tool._meta?.ui, undefined);
    }
    const statelessBash = statelessTools.find(({ name }) => name === "bash_run");
    assert.ok(statelessBash.inputSchema.required.includes("cwd"));

    const statelessCall = async (id, name, args) => (await postJson(statelessEndpoint, {
        jsonrpc: "2.0", id: `req-stateless-${id}`, method: "tools/call",
        params: { name, arguments: args },
    })).body;
    const missingCwd = await statelessCall("missing-cwd", "bash_run", { command: "pwd", waitMs: 30_000 });
    assert.equal(missingCwd.error?.data?.code, "bash.invalidCwd", JSON.stringify(missingCwd));
    const relativeCwd = await statelessCall("relative-cwd", "bash_run", {
        command: "pwd", cwd: "./", waitMs: 30_000,
    });
    assert.equal(relativeCwd.error?.data?.code, "bash.invalidCwd", JSON.stringify(relativeCwd));
    const absoluteCwd = await statelessCall("absolute-cwd", "bash_run", {
        command: "pwd", cwd: fixture.workspace, waitMs: 30_000,
    });
    assert.equal(absoluteCwd.result?.structuredContent?.stdout?.trim(), fixture.workspace, JSON.stringify(absoluteCwd));

    const statelessFile = join(fixture.workspace, "README.md");
    const changes = (path) => `*** Begin Edit\n*** Patch File: ${path}\n@@\n-portable-devshell acceptance workspace\n+patched without a prior read\n*** End Edit`;
    const relativeEdit = await statelessCall("relative-edit", "file_edit", { changes: changes("./README.md") });
    assert.equal(relativeEdit.error?.data?.code, "file.invalidPath", JSON.stringify(relativeEdit));
    const edit = await statelessCall("edit", "file_edit", { changes: changes(statelessFile) });
    assert.equal(edit.error, undefined, JSON.stringify(edit));
    assert.equal(await readFile(statelessFile, "utf8"), "patched without a prior read\n", JSON.stringify(edit));
    const relativeRead = await statelessCall("relative-read", "file_read", {
        files: [{ path: "./README.md", view: "content" }],
    });
    assert.equal(relativeRead.error?.data?.code, "file.invalidPath", JSON.stringify(relativeRead));
    const absoluteRead = await statelessCall("absolute-read", "file_read", {
        files: [{ path: statelessFile, view: "content", selector: "1:raw" }],
    });
    assert.equal(absoluteRead.result?.structuredContent?.files?.[0]?.content,
        "1:patched without a prior read", JSON.stringify(absoluteRead));

    const largeCommand = process.platform === "win32"
        ? "1..2400 | ForEach-Object { [Console]::WriteLine(('line-{0:D4}' -f $_)) }"
        : "awk 'BEGIN { for (i = 1; i <= 2400; i++) printf \"line-%04d\\n\", i }'";
    const statelessOutput = await statelessCall("output", "bash_run", {
        command: largeCommand, cwd: fixture.workspace, waitMs: 30_000,
    });
    const retained = statelessOutput.result?.structuredContent;
    assert.equal(retained?.exitCode, 0, JSON.stringify(statelessOutput));
    assert.equal(retained.stdoutTruncated, true);
    assert.match(retained.stdoutPath, /^\/\.devshell\/tool-results\//u);
    const statelessRecovered = await statelessCall("recover", "file_read", {
        files: [{ path: retained.stdoutPath, view: "content", selector: "1200-1202:raw" }],
    });
    assert.equal(statelessRecovered.result?.structuredContent?.files?.[0]?.content,
        "1200:line-1200\n1201:line-1201\n1202:line-1202", JSON.stringify(statelessRecovered));
    // Search continuation tokens must work across independent MCP requests.
    const searchDir = join(fixture.workspace, "stateless-search");
    await mkdir(searchDir);
    const searchNames = Array.from({ length: 65 }, (_, index) =>
        `entry-${String(index).padStart(3, "0")}-${"a".repeat(40)}.txt`);
    await Promise.all(searchNames.map((name) =>
        writeFile(join(searchDir, name), "stateless-search-marker\n")));
    for (const [tool, query, key] of [
        ["file_glob", { patterns: [join(searchDir, "*.txt")] }, "entries"],
        ["file_grep", { paths: [join(searchDir, "*.txt")], pattern: "stateless-search-marker" }, "files"],
    ]) {
        let cursor;
        let pages = 0;
        const paths = new Set();
        do {
            const result = await statelessCall(`${tool}-${pages++}`, tool, cursor ? { cursor } : query);
            assert.equal(result.error, undefined, JSON.stringify(result));
            const output = result.result.structuredContent;
            for (const entry of output[key]) {
                const path = entry.path.replaceAll("\\", "/");
                assert.ok(!paths.has(path), path);
                paths.add(path);
                if (tool === "file_grep") assert.match(entry.content, /stateless-search-marker/u);
            }
            cursor = output.nextCursor;
            assert.ok(pages < 20, "search cursor must terminate");
        } while (cursor);
        assert.ok(pages > 1);
        assert.deepEqual([...paths].sort(), searchNames.map((name) => join(searchDir, name).replaceAll("\\", "/")).sort());
    }
    for (const [tool, args] of [
        ["file_glob", { patterns: ["./*.txt"] }],
        ["file_grep", { paths: ["./*.txt"], pattern: "marker" }],
        ["file_grep", { pattern: "marker" }],
        ["bash_run", { command: "pwd", pty: true }],
        ["bash_run", { command: "pwd", cwd: "./", pty: true }],
        ["task_manage", { command: "create", cwd: "./" }],
        ["task_manage", { command: "create" }],
    ]) {
        const result = await statelessCall(`invalid-${tool}-${JSON.stringify(args)}`, tool, args);
        assert.ok(result.error, JSON.stringify(result));
    }

    const processTool = async (id, tool, args) => {
        const result = await statelessCall(id, tool, args);
        assert.equal(result.error, undefined, JSON.stringify(result));
        return result.result.structuredContent;
    };
    const noTask = await statelessCall("input-empty", "task_input", { task: "missing", input: "x" });
    assert.ok(noTask.error, JSON.stringify(noTask));
    await processTool("list-before", "task_manage", { command: "list" });
    const created = await processTool("create-terminal", "task_manage", {
        command: "create", name: "stateless-smoke", cwd: fixture.workspace,
    });
    const terminal = created.task?.id;
    assert.equal(typeof terminal, "string");
    const listed = await processTool("list-terminals", "task_manage", { command: "list" });
    assert.ok(listed.tasks.some((entry) => entry.id === terminal && entry.persistent === true && entry.pty === true));
    await processTool("inspect-terminal", "task_inspect", { task: terminal });
    const interactive = process.platform === "win32"
        ? '$value = Read-Host "ready"; Write-Output "received:$value"'
        : "printf 'ready\n'; IFS= read -r value; printf 'received:%s\n' \"$value\"";
    const startedTask = await processTool("run-task", "bash_run", {
        command: interactive, cwd: fixture.workspace, waitMs: 1000, pty: true,
    });
    assert.equal(startedTask.termination, "running", JSON.stringify(startedTask));
    assert.equal(startedTask.detached, undefined);
    const task = startedTask.task.id;
    const finished = await processTool("input-task", "task_input", {
        task, input: "hello\r", cursor: startedTask.cursor, waitMs: 3000, untilExit: true,
    });
    assert.equal(finished.task.status, "0", JSON.stringify(finished));
    assert.match(finished.stdout, /received:hello/u);
    await processTool("close-terminal", "task_manage", { command: "close", task: terminal });
    const closed = await processTool("read-closed", "task_input", {
        task: terminal, untilExit: true, waitMs: 3000,
    });
    assert.notEqual(closed.task.status, "running");
    assert.deepEqual(listContexts(), contextsBefore);

    const discover = await postJson(endpoint, {
        jsonrpc: "2.0",
        id: "req-discover",
        method: "server/discover",
    });
    assert.deepEqual(discover.body.result?.supportedVersions, ["2026-07-28"]);
    assert.equal(discover.headers.get("mcp-session-id"), null);
    assert.equal(
        discover.body.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.version,
        applicationVersion,
    );

    const toolsList = await postJson(
        endpoint,
        {
            jsonrpc: "2.0",
            id: "req-tools-list",
            method: "tools/list",
        },
    );
    const toolNames =
        toolsList.body.result?.tools?.map((tool) => tool.name) ?? [];
    assert.equal(toolNames.includes("environ_info"), true);
    assert.equal(toolNames.includes("bash_run"), true);
    assert.equal(toolNames.includes("context_acquire"), false);
    assert.equal(toolNames.includes("context_renew"), false);

    const environmentCall = await postJson(
        endpoint,
        {
            jsonrpc: "2.0",
            id: "req-environ-info",
            method: "tools/call",
            params: {
                name: "environ_info",
                arguments: { workspace: fixture.workspace },
            },
        },
    );
    const environment = environmentCall.body.result?.structuredContent;
    const ctxId = environment?.ctxId;
    assert.equal(typeof ctxId, "string");
    assert.notEqual(ctxId, "");
    assert.equal(environment?.ctxId, ctxId);
    assert.ok(Array.isArray(environment?.comment));
    assert.equal(environment?.platform, undefined);

    // A bound workspace and the stateless endpoint must not share terminal resources.
    const explicitTerminal = async (id, args) => {
        const result = await postJson(endpoint, {
            jsonrpc: "2.0", id, method: "tools/call",
            params: { name: "task_manage", arguments: { ctxId, ...args } },
        });
        assert.equal(result.body.error, undefined, JSON.stringify(result.body));
        return result.body.result.structuredContent;
    };
    const ordinaryTerminal = (await explicitTerminal("create-workspace-terminal", {
        command: "create", name: "workspace-smoke", cwd: fixture.workspace,
    })).task?.id;
    const ordinaryList = await explicitTerminal("list-workspace-terminals", { command: "list" });
    assert.ok(ordinaryList.tasks.some((entry) => entry.id === ordinaryTerminal && entry.persistent === true && entry.pty === true));
    assert.ok(ordinaryList.tasks.every((entry) => !listed.tasks.some((stateless) => stateless.id === entry.id)));
    const independentList = await processTool("list-independent", "task_manage", { command: "list" });
    assert.ok(independentList.tasks.every((entry) => !ordinaryList.tasks.some((ordinary) => ordinary.id === entry.id)));

    const toolCall = await postJson(
        endpoint,
        {
            jsonrpc: "2.0",
            id: "req-tools-call",
            method: "tools/call",
            params: {
                name: "bash_run",
                arguments: { command: "pwd", ctxId, waitMs: 30_000 },
            },
        },
    );
    assert.equal(JSON.parse(toolCall.body.result?.content?.[0]?.text ?? "{}").stdout,
        toolCall.body.result?.structuredContent?.stdout);
    const output = String(
        toolCall.body.result?.structuredContent?.stdout ?? "",
    );
    assert.equal(output.includes(fixture.workspace), true);

    // A real Worker retains the complete output while the model sees only
    // the budgeted MCP projection. Recover the middle from the retained
    // virtual artifact to prove the truncation is not destructive.
    const large = await postJson(endpoint, {
        jsonrpc: "2.0",
        id: "req-tools-large-output",
        method: "tools/call",
        params: {
            name: "bash_run",
            arguments: { command: largeCommand, ctxId, waitMs: 30_000 },
        },
    });
    const projected = large.body.result?.structuredContent;
    assert.equal(projected?.exitCode, 0);
    assert.equal(projected?.stdoutTruncated, true);
    assert.equal(typeof projected?.stdoutPath, "string");
    assert.equal(Buffer.byteLength(JSON.stringify(projected), "utf8") <= 12_000, true);
    assert.match(projected?.stdout ?? "", /line-0001/u);
    assert.match(projected?.stdout ?? "", /line-2400/u);
    const recovered = await postJson(endpoint, {
        jsonrpc: "2.0",
        id: "req-tools-recover-output",
        method: "tools/call",
        params: {
            name: "file_read",
            arguments: {
                ctxId,
                files: [{
                    path: projected.stdoutPath,
                    view: "content",
                    selector: "1200-1202:raw",
                }],
            },
        },
    });
    assert.equal(recovered.body.result?.structuredContent?.files?.[0]?.content,
        "1200:line-1200\n1201:line-1201\n1202:line-1202");

    // Replay the metadata shape from agy's model calls across the real Control/Worker boundary.
    const agyEndpoint = new URL("./agy-session", endpoint).href;
    const session = { "antigravity.google/conversation_id": "acceptance-conversation" };
    const bootstrap = await postJson(agyEndpoint, {
        jsonrpc: "2.0", id: "req-agy-bootstrap", method: "tools/call",
        params: { name: "environ_info", arguments: { workspace: fixture.workspace }, _meta: session },
    });
    assert.equal(bootstrap.body.error, undefined, JSON.stringify(bootstrap.body));
    assert.ok(bootstrap.body.result?.structuredContent);
    assert.equal(bootstrap.body.result.structuredContent.ctxId, undefined);
    const agyTool = await postJson(agyEndpoint, {
        jsonrpc: "2.0", id: "req-agy-tool", method: "tools/call",
        params: { name: "bash_run", arguments: { command: "pwd", waitMs: 30_000 }, _meta: session },
    });
    assert.equal(agyTool.body.error, undefined, JSON.stringify(agyTool.body));
    assert.equal(agyTool.body.result?.structuredContent?.stdout?.trim(), fixture.workspace);
    assert.equal(agyTool.body.result?.structuredContent?.ctxId, undefined);

    process.stdout.write(
        JSON.stringify(
            {
                environmentCall: environmentCall.body,
                discover: discover.body,
                toolsList: toolsList.body,
                toolCall: toolCall.body,
                largeOutputRecoveryVerified: true,
                agySessionBindingVerified: true,
                statelessVerified: true,
            },
            null,
            2,
        ) + "\n",
    );
} finally {
    await fixture.cleanup({ retireWorker: true });
}

async function postJson(url, body, headers = {}) {
    const response = await post(url, body, headers);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return {
        body: parseMcpResponseBody(response, text),
        headers: response.headers,
    };
}

function parseMcpResponseBody(response, text) {
    const contentType =
        response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/event-stream")) return JSON.parse(text);

    const payloads = [];
    for (const block of text.split(/\r?\n\r?\n/u)) {
        const data = block
            .split(/\r?\n/u)
            .flatMap((line) => {
                const match = /^data:(?: )?(.*)$/u.exec(line);
                return match === null ? [] : [match[1]];
            })
            .join("\n");
        if (data.length > 0) payloads.push(JSON.parse(data));
    }
    assert.equal(
        payloads.length,
        1,
        `Expected one MCP SSE message, received ${payloads.length}.\n${text}`,
    );
    return payloads[0];
}

async function post(url, body, headers = {}) {
    const params = body.params ?? {};
    const name = body.method === "resources/read"
        ? params.uri
        : body.method === "tools/call" || body.method === "prompts/get"
          ? params.name
          : undefined;
    const request = {
        ...body,
        params: {
            ...params,
            _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {
                    name: "portable-devshell-acceptance",
                    version: "0.0.0",
                },
                "io.modelcontextprotocol/clientCapabilities": {},
                ...(params._meta ?? {}),
            },
        },
    };
    return await fetch(url, {
        method: "POST",
        headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": body.method,
            ...(typeof name === "string" ? { "mcp-name": name } : {}),
            ...headers,
        },
        body: JSON.stringify(request),
    });
}
