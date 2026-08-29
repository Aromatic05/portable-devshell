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

    const initialize = await postJson(endpoint, {
        jsonrpc: "2.0",
        id: "req-init",
        method: "initialize",
        params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "acceptance", version: "0.0.0" }
        }
    });
    const protocolVersion = String(initialize.body.result?.protocolVersion ?? "");
    assert.equal(initialize.headers.get("mcp-session-id"), null);
    assert.notEqual(protocolVersion, "");
    assert.equal(initialize.body.result?.serverInfo?.version, applicationVersion);
    const headers = {
        "mcp-protocol-version": protocolVersion
    };

    const initialized = await post(endpoint, {
        jsonrpc: "2.0",
        method: "notifications/initialized"
    }, headers);
    assert.equal(initialized.status, 202);

    const toolsList = await postJson(endpoint, {
        jsonrpc: "2.0",
        id: "req-tools-list",
        method: "tools/list"
    }, headers);
    const toolNames = toolsList.body.result?.tools?.map((tool) => tool.name) ?? [];
    assert.equal(toolNames.includes("context_acquire"), true);
    assert.equal(toolNames.includes("context_renew"), true);
    assert.equal(toolNames.includes("environ_info"), true);
    assert.equal(toolNames.includes("bash_run"), true);

    const contextCall = await postJson(endpoint, {
        jsonrpc: "2.0",
        id: "req-context-acquire",
        method: "tools/call",
        params: { name: "context_acquire", arguments: { workspace: fixture.workspace } }
    }, headers);
    const acquired = contextCall.body.result?.structuredContent;
    const ctxId = acquired?.ctxId;
    assert.equal(typeof ctxId, "string");
    assert.notEqual(ctxId, "");
    assert.equal(acquired?.status, "active");

    const environmentCall = await postJson(endpoint, {
        jsonrpc: "2.0",
        id: "req-environ-info",
        method: "tools/call",
        params: { name: "environ_info", arguments: { ctxId } }
    }, headers);
    const environment = environmentCall.body.result?.structuredContent;
    assert.equal(environment?.ctxId, ctxId);
    assert.equal(environment?.instance, "aromatic-pc");
    assert.equal(environment?.workspace, fixture.workspace);
    assert.equal(typeof environment?.platform?.os, "string");
    assert.equal(typeof environment?.platform?.arch, "string");
    assert.equal(typeof environment?.platform?.distribution?.id, "string");
    assert.equal(typeof environment?.platform?.distribution?.name, "string");
    assert.equal(typeof environment?.platform?.packageManager, "string");
    assert.equal(typeof environment?.platform?.shell, "string");
    assert.equal(Number.isNaN(Date.parse(String(environment?.expiresAt ?? ""))), false);

    const toolCall = await postJson(endpoint, {
        jsonrpc: "2.0",
        id: "req-tools-call",
        method: "tools/call",
        params: {
            name: "bash_run",
            arguments: { command: "pwd", ctxId, timeoutMs: 30_000 }
        }
    }, headers);
    assert.deepEqual(toolCall.body.result?.content, []);
    const output = String(toolCall.body.result?.structuredContent?.stdout ?? "");
    assert.equal(output.includes(fixture.workspace), true);

    process.stdout.write(JSON.stringify({
        contextCall: contextCall.body,
        environmentCall: environmentCall.body,
        initialize: initialize.body,
        toolsList: toolsList.body,
        toolCall: toolCall.body
    }, null, 2) + "\n");
} finally {
    await fixture.cleanup();
}

async function postJson(url, body, headers = {}) {
    const response = await post(url, body, headers);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return { body: JSON.parse(text), headers: response.headers };
}

async function post(url, body, headers = {}) {
    return await fetch(url, {
        method: "POST",
        headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            ...headers
        },
        body: JSON.stringify(body)
    });
}
