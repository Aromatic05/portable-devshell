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
    assert.equal(environment?.instance, "aromatic-pc");
    assert.equal(environment?.workspace, fixture.workspace);
    assert.equal(typeof environment?.platform?.os, "string");
    assert.equal(typeof environment?.platform?.arch, "string");
    assert.equal(typeof environment?.platform?.distribution?.id, "string");
    assert.equal(typeof environment?.platform?.distribution?.name, "string");
    assert.equal(typeof environment?.platform?.packageManager, "string");
    assert.equal(typeof environment?.platform?.shell, "string");
    assert.equal(
        Number.isNaN(Date.parse(String(environment?.expiresAt ?? ""))),
        false,
    );

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

    process.stdout.write(
        JSON.stringify(
            {
                environmentCall: environmentCall.body,
                discover: discover.body,
                toolsList: toolsList.body,
                toolCall: toolCall.body,
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
