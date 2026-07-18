import assert from "node:assert/strict";

import { createAcceptanceFixture, runCli } from "./AcceptanceSupport.mjs";

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
    const sessionId = initialize.headers.get("mcp-session-id");
    const protocolVersion = String(initialize.body.result?.protocolVersion ?? "");
    assert.ok(sessionId);
    assert.notEqual(protocolVersion, "");
    const headers = {
        "mcp-protocol-version": protocolVersion,
        "mcp-session-id": sessionId
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
    assert.equal(toolNames.includes("environ_info"), true);
    assert.equal(toolNames.includes("bash_run"), true);

    const environmentCall = await postJson(endpoint, {
        jsonrpc: "2.0",
        id: "req-environ-info",
        method: "tools/call",
        params: { name: "environ_info", arguments: {} }
    }, headers);
    const environment = environmentCall.body.result?.structuredContent;
    const ctxId = environment?.ctxId;
    assert.equal(typeof ctxId, "string");
    assert.notEqual(ctxId, "");
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
            arguments: { command: "pwd", ctxId }
        }
    }, headers);
    const output = String(toolCall.body.result?.content?.[0]?.text ?? "");
    assert.equal(output.includes(fixture.workspace), true);

    process.stdout.write(JSON.stringify({
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
