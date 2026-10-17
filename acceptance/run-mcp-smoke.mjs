import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createAcceptanceFixture, runCli } from "./AcceptanceSupport.mjs";

const applicationVersion = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;
const fixture = await createAcceptanceFixture();
try {
    runCli(["start"], fixture.env);
    runCli(["instance", "start", "aromatic-pc"], fixture.env);
    const endpoint = `http://127.0.0.1:${fixture.port}/aromatic-pc/mcp`;

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

    const toolCall = await postJson(
        endpoint,
        {
            jsonrpc: "2.0",
            id: "req-tools-call",
            method: "tools/call",
            params: {
                name: "bash_run",
                arguments: { command: "pwd", ctxId, timeoutMs: 30_000 },
            },
        },
    );
    assert.deepEqual(toolCall.body.result?.content, []);
    const output = String(
        toolCall.body.result?.structuredContent?.stdout ?? "",
    );
    assert.equal(output.includes(fixture.workspace), true);

    // A real Worker retains the complete output while the model sees only
    // the budgeted MCP projection. Recover the middle from the retained
    // virtual artifact to prove the truncation is not destructive.
    const largeCommand = process.platform === "win32"
        ? "1..2400 | ForEach-Object { [Console]::WriteLine(('line-{0:D4}' -f $_)) }"
        : "awk 'BEGIN { for (i = 1; i <= 2400; i++) printf \"line-%04d\\n\", i }'";
    const large = await postJson(endpoint, {
        jsonrpc: "2.0",
        id: "req-tools-large-output",
        method: "tools/call",
        params: {
            name: "bash_run",
            arguments: { command: largeCommand, ctxId, timeoutMs: 30_000 },
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

    process.stdout.write(
        JSON.stringify(
            {
                environmentCall: environmentCall.body,
                discover: discover.body,
                toolsList: toolsList.body,
                toolCall: toolCall.body,
                largeOutputRecoveryVerified: true,
            },
            null,
            2,
        ) + "\n",
    );
} finally {
    await fixture.cleanup();
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
